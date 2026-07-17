$ErrorActionPreference = 'Stop'
$runtimePath = Join-Path $PSScriptRoot '.dev'
$statePath = Join-Path $runtimePath 'processes.json'

if (-not (Test-Path $statePath)) {
    Write-Host 'No native development processes are recorded.'
    exit 0
}

$state = Get-Content $statePath -Raw | ConvertFrom-Json
foreach ($property in @('backendPid', 'frontendPid')) {
    $processId = $state.$property
    if ($processId -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
        & taskkill.exe /PID $processId /T /F 2>$null | Out-Null
    }
}
Remove-Item $statePath -Force
Write-Host 'Native backend and frontend stopped. PostgreSQL is still running in Docker.'
