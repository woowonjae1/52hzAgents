$ErrorActionPreference = 'Stop'

$stoppedAny = $false
foreach ($runtimeDir in @('.dev-sqlite', '.dev')) {
    $runtimePath = Join-Path $PSScriptRoot $runtimeDir
    $statePath = Join-Path $runtimePath 'processes.json'

    if (Test-Path $statePath) {
        try {
            $state = Get-Content $statePath -Raw | ConvertFrom-Json
            foreach ($property in @('backendPid', 'frontendPid', 'connectorPid')) {
                $processId = $state.$property
                if ($processId -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
                    try {
                        Start-Process -FilePath taskkill.exe -ArgumentList @('/PID', "$processId", '/T', '/F') -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue
                    } catch {}
                }
            }
            $stoppedAny = $true
        } finally {
            Remove-Item $statePath -Force -ErrorAction SilentlyContinue
        }
    }
}

if ($stoppedAny) {
    Write-Host 'Native dev stack processes stopped.' -ForegroundColor Yellow
} else {
    Write-Host 'No native development processes are recorded.' -ForegroundColor DarkGray
}
