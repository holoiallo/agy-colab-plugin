# colab.ps1 -- run remote Colab from one command; refreshes the ADC token for you.
# (ASCII only: PowerShell 5 reads BOM-less .ps1 as ANSI and mangles non-ASCII.)
#
# Usage:
#   .\colab.ps1 specs
#   .\colab.ps1 run --script tools\blender_job.py --spec gpu_t4
#   .\colab.ps1 exec --code "print(1+1)"
#   .\colab.ps1 ls ; .\colab.ps1 rm runtimes/xxxx
#
# One-time setup (already done on this machine):
#   1) gcloud auth application-default login --launch-browser --scopes="https://www.googleapis.com/auth/colaboratory,https://www.googleapis.com/auth/cloud-platform,openid,https://www.googleapis.com/auth/userinfo.email"
#   2) gcloud projects create <ID> ; gcloud services enable colaboratory.googleapis.com --project=<ID>
#   3) gcloud auth application-default set-quota-project <ID>
#   4) gcloud projects add-iam-policy-binding <ID> --member="user:you@gmail.com" --role="roles/serviceusage.serviceUsageConsumer"
#   5) put <ID> into colabkit\.project

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here

$gcloud = @(
  "C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd",
  "C:\Program Files\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd",
  "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $gcloud) { throw "gcloud.cmd not found" }

$projFile = Join-Path $root ".project"
if (-not (Test-Path $projFile)) { throw "missing $projFile (put your Cloud project id in it)" }
$env:COLAB_QUOTA_PROJECT = (Get-Content $projFile -Raw).Trim()

$token = (& $gcloud auth application-default print-access-token 2>$null | Select-Object -First 1)
if (-not $token) { throw "no ADC token: run gcloud auth application-default login first" }
$env:COLAB_TOKEN = $token

& node (Join-Path $here "colab_mcp.mjs") @args
exit $LASTEXITCODE
