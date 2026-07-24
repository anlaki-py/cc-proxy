# install.ps1 — install cc-proxy from a clone of the repo.
#
# Default flow:  npm install  ->  npm test  ->  npm run build  ->  npm link
# Flags:
#   -SkipTest        Skip both `npm install` and `npm test` (deps already
#                    present and a build is all that's needed); still
#                    builds + links.
#   -Help            Show this message and exit
#
# Any unknown flag is an error. Each step bails on failure so you keep
# the last good build.

[CmdletBinding()]
param(
  [switch]$SkipTest,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help) {
  # Print the leading comment block (lines starting with '# ') up to the
  # first line that is not a comment, with the '# ' prefix stripped.
  $lines = Get-Content $PSCommandPath
  foreach ($line in $lines) {
    if ($line -notmatch '^#') { break }
    if ($line.Length -ge 2) { Write-Host $line.Substring(2) }
    else { Write-Host '' }
  }
  exit 0
}

# Resolve repo root = directory of this script, regardless of cwd.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $scriptDir

# Node 18+ guard — mirrors bin/cc-proxy.js so the error message is familiar.
$nodeVersion = (node -v) 2>$null
if (-not $nodeVersion) {
  Write-Error 'install.ps1: node was not found on PATH. Install Node 18+ from https://nodejs.org/'
  exit 1
}
$major = [int]($nodeVersion -replace '^v', '' -split '\.')[0]
if ($major -lt 18) {
  Write-Error "cc-proxy requires Node.js 18 or newer (found $nodeVersion).`nPlease upgrade Node: https://nodejs.org/"
  exit 1
}

Write-Host "==> cc-proxy install (SkipTest=$SkipTest)"

if (-not $SkipTest) {
  Write-Host '==> npm install'
  npm install
  if ($LASTEXITCODE -ne 0) { Write-Error 'npm install failed'; exit $LASTEXITCODE }
  Write-Host '==> npm test'
  npm test
  if ($LASTEXITCODE -ne 0) { Write-Error 'npm test failed'; exit $LASTEXITCODE }
} else {
  Write-Host '==> (skipping npm install + npm test)'
}

Write-Host '==> npm run build'
npm run build
if ($LASTEXITCODE -ne 0) { Write-Error 'npm run build failed'; exit $LASTEXITCODE }

Write-Host '==> npm link'
npm link
if ($LASTEXITCODE -ne 0) { Write-Error 'npm link failed'; exit $LASTEXITCODE }

Write-Host '==> done. cc-proxy is now available as ''cc-proxy'' on your PATH.'
