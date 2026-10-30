[CmdletBinding()]
param([switch]$NoBuild)
. (Join-Path $PSScriptRoot 'Common.ps1')
& (Join-Path $PSScriptRoot 'Init.ps1')
$rolloutPreviousTemp = [Environment]::GetEnvironmentVariable('TEMP','Process')
$rolloutPreviousTmp = [Environment]::GetEnvironmentVariable('TMP','Process')
Push-Location $script:RolloutRoot
try {
  $rolloutTemp = Join-Path $script:RolloutRoot '.local/tmp'
  New-Item -ItemType Directory -Path $rolloutTemp -Force | Out-Null
  $env:TEMP = $rolloutTemp
  $env:TMP = $rolloutTemp
  $rolloutCompose = @('compose','-f','compose.yml','-p','rolloutdesk')
  if (-not $NoBuild) {
    Invoke-RolloutDocker -Arguments ($rolloutCompose + @('build','api'))
    Invoke-RolloutDocker -Arguments ($rolloutCompose + @('build','web'))
  }
  Invoke-RolloutDocker -Arguments ($rolloutCompose + @('up','-d','--no-build','--wait','--wait-timeout','180'))
  Write-Output 'RolloutDesk: http://127.0.0.1:8098'
  Write-Output 'Private account: .local/LOCAL-CREDENTIALS.txt'
} finally {
  [Environment]::SetEnvironmentVariable('TEMP',$rolloutPreviousTemp,'Process')
  [Environment]::SetEnvironmentVariable('TMP',$rolloutPreviousTmp,'Process')
  Pop-Location
}
