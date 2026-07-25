<#
Reads the 5 secrets this project's GitHub Actions workflow needs straight from your local
.env and service-account-key.json (files you already filled in), and uploads them to the
repo via `gh secret set`. Run this yourself from a terminal in this project folder:

    .\scripts\upload-secrets.ps1

Requires: `gh auth login` already completed once (interactive GitHub sign-in - not
something this script does for you).
#>

$ErrorActionPreference = 'Stop'
$repo = 'omegaXcoder/holmes-mix-sheet'
$projectRoot = Split-Path -Parent $PSScriptRoot

function Get-EnvValue {
    param([string]$Name, [string]$EnvPath)
    $line = Get-Content $EnvPath | Where-Object { $_ -match "^\s*$Name\s*=" } | Select-Object -First 1
    if (-not $line) { throw "`"$Name`" not found in $EnvPath" }
    $value = $line -replace "^\s*$Name\s*=\s*", ''
    # Strip a single matching pair of surrounding quotes, if present (e.g. SA_PASSWORD="abc#def")
    if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    return $value
}

$envPath = Join-Path $projectRoot '.env'
$keyPath = Join-Path $projectRoot 'service-account-key.json'

if (-not (Test-Path $envPath)) { throw "Missing $envPath - fill it in first (see .env.example)." }
if (-not (Test-Path $keyPath)) { throw "Missing $keyPath - see README step 2." }

Write-Output "Uploading secrets to $repo ..."

gh secret set SA_EMAIL --repo $repo --body (Get-EnvValue 'SA_EMAIL' $envPath)
Write-Output '  SA_EMAIL set'

gh secret set SA_PASSWORD --repo $repo --body (Get-EnvValue 'SA_PASSWORD' $envPath)
Write-Output '  SA_PASSWORD set'

Get-Content $keyPath -Raw | gh secret set GOOGLE_SERVICE_ACCOUNT_KEY_JSON --repo $repo
Write-Output '  GOOGLE_SERVICE_ACCOUNT_KEY_JSON set'

gh secret set SMTP_FROM_EMAIL --repo $repo --body (Get-EnvValue 'SMTP_FROM_EMAIL' $envPath)
Write-Output '  SMTP_FROM_EMAIL set'

gh secret set SMTP_APP_PASSWORD --repo $repo --body (Get-EnvValue 'SMTP_APP_PASSWORD' $envPath)
Write-Output '  SMTP_APP_PASSWORD set'

Write-Output "Done. Verify at: https://github.com/$repo/settings/secrets/actions"
