[CmdletBinding()]
param(
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = $PSScriptRoot
$backendPath = Join-Path $workspaceRoot 'backend'
$frontendPath = Join-Path $workspaceRoot 'frontend'
$runtimePath = Join-Path $workspaceRoot '.dev'
$statePath = Join-Path $runtimePath 'processes.json'
$backendLog = Join-Path $runtimePath 'backend.log'
$frontendLog = Join-Path $runtimePath 'frontend.log'

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is required. Install it and ensure it is on PATH."
    }
}

function Stop-ManagedProcesses {
    if (-not (Test-Path $statePath)) { return }
    try {
        $state = Get-Content $statePath -Raw | ConvertFrom-Json
        foreach ($property in @('backendPid', 'frontendPid')) {
            $processId = $state.$property
            if ($processId -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
                # Go and Next spawn child processes. taskkill /T prevents those
                # children from surviving a restart of this development script.
                & taskkill.exe /PID $processId /T /F 2>$null | Out-Null
            }
        }
    } finally {
        Remove-Item $statePath -Force -ErrorAction SilentlyContinue
    }
}

function Wait-Http([string]$Url, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec 3
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return }
        } catch {
            # The server is still starting.
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "Timed out waiting for $Url"
}

Require-Command docker
Require-Command go
Require-Command npm

New-Item -ItemType Directory -Force -Path $runtimePath, (Join-Path $runtimePath 'files') | Out-Null

Push-Location $workspaceRoot
try {
    # Keep only PostgreSQL in Docker. Stop Compose's app containers so the
    # native processes below can use the normal http://localhost:8000/3000 ports.
    docker compose up -d db
    docker compose stop backend frontend | Out-Null

    $dbDeadline = (Get-Date).AddSeconds(45)
    do {
        docker compose exec -T db pg_isready -U postgres | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $dbDeadline)
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL did not become ready within 45 seconds.' }

    if (-not $SkipInstall -and -not (Test-Path (Join-Path $frontendPath 'node_modules'))) {
        Write-Host 'Installing frontend dependencies (first run only)...'
        Push-Location $frontendPath
        try { npm ci } finally { Pop-Location }
    }

    Stop-ManagedProcesses
    Remove-Item $backendLog, $frontendLog -Force -ErrorAction SilentlyContinue

    $backendCommand = "Set-Location -LiteralPath '$backendPath'; `$env:DATABASE_URL = 'postgresql://postgres:dev@localhost:5432/openagents_workspace'; `$env:AUTH_MODE = 'workspace_token'; `$env:CORS_ORIGINS = 'http://localhost:3000'; `$env:FILE_STORAGE_PATH = '$(Join-Path $runtimePath 'files')'; & go run ./cmd/server *>> '$backendLog'"
    $frontendCommand = "Set-Location -LiteralPath '$frontendPath'; `$env:NEXT_PUBLIC_API_URL = 'http://localhost:8000'; & '$frontendPath\node_modules\.bin\next.cmd' dev -p 3000 *>> '$frontendLog'"

    $backend = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $backendCommand) -WindowStyle Hidden -PassThru
    $frontend = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $frontendCommand) -WindowStyle Hidden -PassThru
    @{ backendPid = $backend.Id; frontendPid = $frontend.Id } | ConvertTo-Json | Set-Content -Encoding UTF8 $statePath

    try {
        # A cold `go run` can spend more than 45 seconds compiling dependencies.
        Wait-Http 'http://localhost:8000/v1/health' 120
        Wait-Http 'http://localhost:3000/' 60
    } catch {
        Stop-ManagedProcesses
        throw "$($_.Exception.Message)`nBackend log: $backendLog`nFrontend log: $frontendLog"
    }

    Write-Host ''
    Write-Host 'Native development environment is ready:' -ForegroundColor Green
    Write-Host '  Frontend: http://localhost:3000 (Next.js hot reload)'
    Write-Host '  Backend:  http://localhost:8000/v1/health (Go reload after restart)'
    Write-Host "  Logs:     $runtimePath"
    Write-Host 'Stop it with: .\workspace\stop-dev.ps1'
} finally {
    Pop-Location
}
