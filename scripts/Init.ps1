[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'init-env.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Private setup failed.' }
