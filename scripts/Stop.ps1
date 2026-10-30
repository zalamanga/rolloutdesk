[CmdletBinding()]
param()
. (Join-Path $PSScriptRoot 'Common.ps1')
Push-Location $script:RolloutRoot
try { Invoke-RolloutDocker -Arguments @('compose','-f','compose.yml','-p','rolloutdesk','down') } finally { Pop-Location }
Write-Output 'RolloutDesk stopped; PostgreSQL application volume preserved.'
