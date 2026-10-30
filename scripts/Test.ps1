[CmdletBinding()]
param([switch]$WithBrowser)
. (Join-Path $PSScriptRoot 'Common.ps1')
& (Join-Path $PSScriptRoot 'Init.ps1')
if (Get-NetTCPConnection -State Listen -LocalPort 5451 -ErrorAction SilentlyContinue) { throw 'Port 5451 is occupied. Tests will not use an existing database.' }
$rolloutValues = Get-RolloutEnvironment
$rolloutNames = @('ROLLOUT_TEST_DB_PASSWORD','ROLLOUT_DEMO_PASSWORD','ROLLOUT_STAGING_TOKEN','ROLLOUT_PRODUCTION_TOKEN','ROLLOUT_BASE_URL','npm_config_cache','NODE_OPTIONS','TEMP','TMP')
$rolloutPrevious = @{}
foreach ($rolloutName in $rolloutNames) { $rolloutPrevious[$rolloutName] = [Environment]::GetEnvironmentVariable($rolloutName,'Process') }
Push-Location $script:RolloutRoot
$rolloutStarted = $false
try {
  $rolloutTemp = Join-Path $script:RolloutRoot '.local/tmp'
  New-Item -ItemType Directory -Path $rolloutTemp -Force | Out-Null
  $env:TEMP = $rolloutTemp
  $env:TMP = $rolloutTemp
  $env:ROLLOUT_TEST_DB_PASSWORD = $rolloutValues['ROLLOUT_TEST_DB_PASSWORD']
  $rolloutCompose = @('compose','-f','compose.test.yml','-p','rolloutdesk-test')
  Invoke-RolloutDocker -Arguments ($rolloutCompose + @('build','tests'))
  $rolloutStarted = $true
  Invoke-RolloutDocker -Arguments ($rolloutCompose + @('up','-d','--wait','--wait-timeout','90','db'))
  Invoke-RolloutDocker -Arguments ($rolloutCompose + @('run','--rm','--no-deps','tests'))
  $env:npm_config_cache = Join-Path $script:RolloutRoot '.local/npm-cache'
  $env:NODE_OPTIONS = '--max-old-space-size=512'
  Push-Location (Join-Path $script:RolloutRoot 'frontend')
  try {
    if (-not (Test-Path -LiteralPath 'node_modules/.package-lock.json')) {
      & npm.cmd ci --ignore-scripts
      if ($LASTEXITCODE -ne 0) { throw 'Frontend install failed.' }
    }
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'Frontend tests failed.' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    if ($WithBrowser) {
      foreach ($rolloutName in @('ROLLOUT_DEMO_PASSWORD','ROLLOUT_STAGING_TOKEN','ROLLOUT_PRODUCTION_TOKEN')) { [Environment]::SetEnvironmentVariable($rolloutName,$rolloutValues[$rolloutName],'Process') }
      $env:ROLLOUT_BASE_URL = 'http://127.0.0.1:8098'
      & npm.cmd run test:e2e
      if ($LASTEXITCODE -ne 0) { throw 'Browser tests failed.' }
    }
  } finally { Pop-Location }
} finally {
  try { if ($rolloutStarted) { Invoke-RolloutDocker -Arguments ($rolloutCompose + @('down')) } }
  finally {
    foreach ($rolloutName in $rolloutNames) { [Environment]::SetEnvironmentVariable($rolloutName,$rolloutPrevious[$rolloutName],'Process') }
    Pop-Location
  }
}
Write-Output 'Rust/PostgreSQL tests and frontend checks completed.'
