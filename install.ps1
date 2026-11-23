# install.ps1 -- Install agy-colab-plugin into Antigravity (%USERPROFILE%\.gemini\config\plugins\colab)
# (ASCII only: PowerShell 5 reads BOM-less .ps1 as ANSI.)
#
# Usage:
#   .\install.ps1 -ProjectId <YOUR_GCP_PROJECT_ID>
#   .\install.ps1 -ProjectId <YOUR_GCP_PROJECT_ID> -Force

param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginDir = Join-Path $env:USERPROFILE ".gemini\config\plugins\colab"

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { $nodeExe = "C:\Program Files\nodejs\node.exe" }
if (-not (Test-Path $nodeExe)) { throw "node.exe not found. Please install Node.js 20+." }

$gcloud = @(
  "C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd",
  "C:\Program Files\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd",
  "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $gcloud) { throw "gcloud.cmd not found. Please install Google Cloud SDK." }

Write-Host "[1/3] Installing plugin files into $pluginDir ..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $pluginDir, "$pluginDir\assets", "$pluginDir\rules", "$pluginDir\skills\cloud-compute" | Out-Null

Copy-Item -Force (Join-Path $repoDir "plugin.json") (Join-Path $pluginDir "plugin.json")
Copy-Item -Force (Join-Path $repoDir "assets\logo.svg") (Join-Path $pluginDir "assets\logo.svg")
Copy-Item -Force (Join-Path $repoDir "rules\AGENTS.md") (Join-Path $pluginDir "rules\AGENTS.md")
Copy-Item -Force (Join-Path $repoDir "skills\cloud-compute\SKILL.md") (Join-Path $pluginDir "skills\cloud-compute\SKILL.md")
Copy-Item -Recurse -Force (Join-Path $repoDir "tools") (Join-Path $pluginDir "tools")

# Write sanitized SKILL.md pointing to installed tools path
$skillPath = Join-Path $pluginDir "skills\cloud-compute\SKILL.md"
$skillText = (Get-Content $skillPath -Raw -Encoding UTF8).Replace("<PLUGIN_DIR>", $pluginDir)
[System.IO.File]::WriteAllText($skillPath, $skillText, (New-Object System.Text.UTF8Encoding $false))

$mcpPath = Join-Path $pluginDir "mcp_config.json"
if ((Test-Path $mcpPath) -and -not $Force) {
  Write-Host "[2/3] Existing mcp_config.json found; skipping overwrite (pass -Force to regenerate)." -ForegroundColor Yellow
} else {
  Write-Host "[2/3] Generating mcp_config.json for project '$ProjectId' ..." -ForegroundColor Cyan
  $cfg = [pscustomobject]@{
    mcpServers = [pscustomobject]@{
      colab = [pscustomobject]@{
        command = $nodeExe
        args = @((Join-Path $pluginDir "tools\colab-mcp-server.mjs"))
        env = [pscustomobject]@{
          COLAB_PROJECT = $ProjectId
          GCLOUD_CMD = $gcloud
        }
      }
    }
  }
  $json = ($cfg | ConvertTo-Json -Depth 10) + "`n"
  [System.IO.File]::WriteAllText($mcpPath, $json, (New-Object System.Text.UTF8Encoding $false))
}

Write-Host "[3/3] Done! Restart Antigravity to load the plugin." -ForegroundColor Green
Write-Host "      To add extra accounts later, run: `"$pluginDir\tools\add-account.ps1`" -ProfileName pro2"
