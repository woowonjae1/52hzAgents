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
        try {
            $kill = Start-Process -FilePath taskkill.exe -ArgumentList @('/PID', "$processId", '/T', '/F') -WindowStyle Hidden -Wait -PassThru
            if ($kill.ExitCode -ne 0) {
                Write-Verbose "Could not terminate recorded process $processId (it may already be exiting)."
            }
        } catch {
            Write-Verbose "Could not terminate recorded process ${processId}: $($_.Exception.Message)"
        }
    }
}
Remove-Item $statePath -Force
Write-Host 'Native backend and frontend stopped. PostgreSQL is still running in Docker.'
