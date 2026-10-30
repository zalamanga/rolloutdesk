[CmdletBinding()]
param([ValidateSet('staging','production')][string]$Environment = 'staging',[string]$FlagKey = 'checkout-redesign',[string]$SubjectId = 'demo-customer-001')
. (Join-Path $PSScriptRoot 'Common.ps1')
$rolloutValues = Get-RolloutEnvironment
$rolloutToken = $rolloutValues['ROLLOUT_' + $Environment.ToUpperInvariant() + '_TOKEN']
$rolloutBody = @{flagKey=$FlagKey;subjectId=$SubjectId} | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri ('http://127.0.0.1:8098/client/v1/evaluate/' + $Environment) -ContentType 'application/json' -Headers @{Authorization=('Bearer ' + $rolloutToken)} -Body $rolloutBody
