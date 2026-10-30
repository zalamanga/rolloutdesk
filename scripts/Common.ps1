$ErrorActionPreference = 'Stop'
$script:RolloutRoot = Split-Path -Parent $PSScriptRoot
function Invoke-RolloutDocker {
  param([Parameter(Mandatory=$true)][string[]]$Arguments)
  $rolloutPreviousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Docker command failed. Review the output above.' }
  } finally { $ErrorActionPreference = $rolloutPreviousPreference }
}
function Get-RolloutEnvironment {
  $rolloutValues = @{}
  $rolloutFile = Join-Path $script:RolloutRoot '.env'
  if (-not (Test-Path -LiteralPath $rolloutFile)) { throw 'Run scripts/Init.ps1 first.' }
  foreach ($rolloutLine in [IO.File]::ReadAllLines($rolloutFile)) {
    if ($rolloutLine -match '^([A-Z][A-Z0-9_]*)=(.*)$') { $rolloutValues[$matches[1]] = $matches[2] }
  }
  foreach ($rolloutName in @('ROLLOUT_DB_PASSWORD','ROLLOUT_DEMO_PASSWORD','ROLLOUT_STAGING_TOKEN','ROLLOUT_PRODUCTION_TOKEN','ROLLOUT_TEST_DB_PASSWORD')) {
    if ($rolloutValues[$rolloutName] -notmatch '^[0-9a-f]{64}$') { throw 'Private configuration is incomplete; run scripts/Init.ps1.' }
  }
  return $rolloutValues
}
