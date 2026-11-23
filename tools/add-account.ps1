# add-account.ps1 -- Add an isolated Google account profile for colab MCP (multi-account).
# (ASCII only: PowerShell 5 reads BOM-less .ps1 as ANSI and mangles non-ASCII.)
#
# Usage:
#   .\tools\add-account.ps1 -ProfileName pro2
#   .\tools\add-account.ps1 -ProfileName pro3 -CreateProject
#
# What it does:
#   1. Creates an isolated CLOUDSDK_CONFIG dir: %USERPROFILE%\.gcloud-<ProfileName>
#   2. Opens browser OAuth for ADC login with the colaboratory scope
#   3. Binds quota project (reuses colabkit\.project + grants serviceUsageConsumer via default gcloud,
#      or creates a separate GCP project when -CreateProject is passed)
#   4. Tests colab_subscription + colab_specs under the new profile
#   5. Registers mcpServers["colab_<ProfileName>"] in ~/.gemini/config/plugins/colab/mcp_config.json

param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z0-9_-]+$')]
  [string]$ProfileName,

  [string]$ProjectId = "",
  [switch]$CreateProject,
  [switch]$SkipRegister
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here

$gcloud = @(
  "C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd",
  "C:\Program Files\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd",
  "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $gcloud) { throw "gcloud.cmd not found" }

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { $nodeExe = "C:\Program Files\nodejs\node.exe" }
if (-not (Test-Path $nodeExe)) { throw "node.exe not found" }

$configDir = Join-Path $env:USERPROFILE ".gcloud-$ProfileName"
$stateDir = Join-Path $configDir ".colabkit-mcp"
New-Item -ItemType Directory -Force -Path $configDir | Out-Null

$scopes = "https://www.googleapis.com/auth/colaboratory,https://www.googleapis.com/auth/cloud-platform,openid,https://www.googleapis.com/auth/userinfo.email"

Write-Host "[1/5] Browser ADC login for profile '$ProfileName' ($configDir)..." -ForegroundColor Cyan
$prevConfig = $env:CLOUDSDK_CONFIG
$env:CLOUDSDK_CONFIG = $configDir
try {
  & $gcloud auth application-default login --launch-browser --scopes="$scopes"
  if ($LASTEXITCODE -ne 0) { throw "ADC login failed" }

  $token = (& $gcloud auth application-default print-access-token | Select-Object -First 1).Trim()
  if (-not $token) { throw "Failed to obtain ADC access token" }
  $info = Invoke-RestMethod -Uri "https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=$token"
  $email = $info.email
  Write-Host "    Logged in as: $email" -ForegroundColor Green

  if ($CreateProject) {
    Write-Host "[2/5] Creating dedicated GCP project under $email..." -ForegroundColor Cyan
    & $gcloud auth login --launch-browser
    if ($LASTEXITCODE -ne 0) { throw "gcloud auth login failed" }
    if (-not $ProjectId) {
      $suffix = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
      $ProjectId = "colabkit-$suffix"
    }
    & $gcloud projects create $ProjectId --name="colabkit-$ProfileName"
    if ($LASTEXITCODE -ne 0) { throw "projects create failed" }
    & $gcloud services enable colaboratory.googleapis.com --project=$ProjectId
    if ($LASTEXITCODE -ne 0) { throw "services enable failed" }
    & $gcloud projects add-iam-policy-binding $ProjectId --member="user:$email" --role="roles/serviceusage.serviceUsageConsumer" | Out-Null
  } else {
    if (-not $ProjectId) {
      $projFile = Join-Path $root ".project"
      if (Test-Path $projFile) {
        $ProjectId = (Get-Content $projFile -Raw).Trim()
      } else {
        $mcpPathTmp = Join-Path $env:USERPROFILE ".gemini\config\plugins\colab\mcp_config.json"
        if (Test-Path $mcpPathTmp) {
          $mcpTmp = Get-Content $mcpPathTmp -Raw | ConvertFrom-Json
          $ProjectId = $mcpTmp.mcpServers.colab.env.COLAB_PROJECT
        }
      }
      if (-not $ProjectId) { throw "Missing .project / mcp_config COLAB_PROJECT and no -ProjectId passed" }
    }
    Write-Host "[2/5] Granting serviceUsageConsumer on '$ProjectId' to $email via default gcloud..." -ForegroundColor Cyan
    $env:CLOUDSDK_CONFIG = $prevConfig
    & $gcloud projects add-iam-policy-binding $ProjectId --member="user:$email" --role="roles/serviceusage.serviceUsageConsumer" | Out-Null
    $env:CLOUDSDK_CONFIG = $configDir
    if ($LASTEXITCODE -ne 0) { throw "IAM binding failed (run with -CreateProject instead if default account does not own $ProjectId)" }
  }

  Write-Host "[3/5] Setting ADC quota project to '$ProjectId'..." -ForegroundColor Cyan
  & $gcloud auth application-default set-quota-project $ProjectId | Out-Null

  Write-Host "[4/5] Verifying Colab subscription and GPU specs..." -ForegroundColor Cyan
  if (-not $env:HTTPS_PROXY) {
    $inet = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction SilentlyContinue
    if ($inet -and $inet.ProxyEnable -eq 1 -and $inet.ProxyServer) {
      $proxy = $inet.ProxyServer
      if ($proxy -notmatch '^https?://') { $proxy = "http://$proxy" }
      $env:HTTPS_PROXY = $proxy
      $env:NODE_USE_ENV_PROXY = "1"
    }
  }
  $env:COLAB_QUOTA_PROJECT = $ProjectId
  $env:COLAB_TOKEN = (& $gcloud auth application-default print-access-token | Select-Object -First 1).Trim()
  & $nodeExe (Join-Path $here "colab_mcp.mjs") subscription
  & $nodeExe (Join-Path $here "colab_mcp.mjs") specs
}
finally {
  $env:CLOUDSDK_CONFIG = $prevConfig
  Remove-Item Env:COLAB_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:COLAB_QUOTA_PROJECT -ErrorAction SilentlyContinue
}

if (-not $SkipRegister) {
  $mcpPath = Join-Path $env:USERPROFILE ".gemini\config\plugins\colab\mcp_config.json"
  if (Test-Path $mcpPath) {
    Write-Host "[5/5] Registering 'colab_$ProfileName' in $mcpPath..." -ForegroundColor Cyan
    $cfg = Get-Content $mcpPath -Raw | ConvertFrom-Json
    if (-not $cfg.mcpServers) { $cfg | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) }
    $serverKey = "colab_$ProfileName"
    $serverObj = [pscustomobject]@{
      command = $nodeExe
      args = @((Join-Path $here "colab-mcp-server.mjs"))
      env = [pscustomobject]@{
        COLAB_PROJECT = $ProjectId
        CLOUDSDK_CONFIG = $configDir
        COLAB_STATE_DIR = $stateDir
        GCLOUD_CMD = $gcloud
      }
    }
    if ($cfg.mcpServers.PSObject.Properties.Name -contains $serverKey) {
      $cfg.mcpServers.$serverKey = $serverObj
    } else {
      $cfg.mcpServers | Add-Member -NotePropertyName $serverKey -NotePropertyValue $serverObj
    }
    $jsonText = ($cfg | ConvertTo-Json -Depth 10) + "`n"
    [System.IO.File]::WriteAllText($mcpPath, $jsonText, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "    Added MCP server '$serverKey'. Restart Antigravity to load it." -ForegroundColor Green
  }
}
