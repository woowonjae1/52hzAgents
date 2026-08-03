# Local development launcher — SQLite backend + Next.js frontend, no Docker.
#
# Runs the Go backend against a pure-Go SQLite database (CGO_ENABLED=0, no gcc
# required) and the Next.js frontend with hot reload. Data lives under
# workspace/.dev-sqlite so it survives restarts.
#
#   .\workspace\dev-sqlite.ps1            # start both
#   .\workspace\dev-sqlite.ps1 -Stop      # stop both
[CmdletBinding()]
param([switch]$Stop)

$ErrorActionPreference = 'Stop'
$workspaceRoot = $PSScriptRoot
$backendPath = Join-Path $workspaceRoot 'backend'
$frontendPath = Join-Path $workspaceRoot 'frontend'
$runtimePath = Join-Path $workspaceRoot '.dev-sqlite'
$statePath = Join-Path $runtimePath 'processes.json'
$backendLog = Join-Path $runtimePath 'backend.log'
$frontendLog = Join-Path $runtimePath 'frontend.log'
$dbPath = Join-Path $runtimePath 'workspace.db'
$filesPath = Join-Path $runtimePath 'files'

function Resolve-Go {
    foreach ($c in @('go', 'C:\Program Files\Go\bin\go.exe', "$env:LOCALAPPDATA\Programs\Go\bin\go.exe")) {
        if (Get-Command $c -ErrorAction SilentlyContinue) { return (Get-Command $c).Source }
        if (Test-Path $c) { return $c }
    }
    throw 'Go not found. Install it (winget install GoLang.Go) and retry.'
}

function Stop-Managed {
    if (-not (Test-Path $statePath)) { return }
    try {
        $state = Get-Content $statePath -Raw | ConvertFrom-Json
        foreach ($p in @('backendPid', 'frontendPid', 'connectorPid')) {
            $procId = $state.$p
            if ($procId -and (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
                Start-Process taskkill.exe -ArgumentList @('/PID', "$procId", '/T', '/F') -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue
            }
        }
    } finally { Remove-Item $statePath -Force -ErrorAction SilentlyContinue }
}

Stop-Managed
if ($Stop) { Write-Host 'Stopped local dev processes.' -ForegroundColor Yellow; return }

$go = Resolve-Go
New-Item -ItemType Directory -Force -Path $runtimePath, $filesPath | Out-Null
Remove-Item $backendLog, $frontendLog -Force -ErrorAction SilentlyContinue

if (-not (Test-Path (Join-Path $frontendPath 'node_modules'))) {
    Write-Host 'Installing frontend dependencies (first run only)...' -ForegroundColor Cyan
    Push-Location $frontendPath
    try { npm install } finally { Pop-Location }
}

# Backend: pure-Go SQLite, no cgo.
$backendCmd = @"
Set-Location -LiteralPath '$backendPath'
`$env:CGO_ENABLED = '0'
`$env:DATABASE_URL = 'sqlite://$dbPath'
`$env:AUTH_MODE = 'none'
`$env:CORS_ORIGINS = '*'
`$env:FILE_STORAGE_PATH = '$filesPath'
`$env:REQUESTS_PER_MINUTE = '1000'
`$env:ROUTER_LLM_ENABLED = 'false'
& '$go' run ./cmd/server *>> '$backendLog'
"@

$connectorPath = Join-Path $workspaceRoot '..' | Join-Path -ChildPath 'packages\wwj'
$connectorLog = Join-Path $runtimePath 'connector.log'

$frontendCmd = @"
Set-Location -LiteralPath '$frontendPath'
`$env:NEXT_PUBLIC_API_URL = 'http://localhost:8000'
& '$frontendPath\node_modules\.bin\next.cmd' dev -p 3005 *>> '$frontendLog'
"@

$connectorCmd = @"
Set-Location -LiteralPath '$connectorPath'
`$env:WWJ_WORKSPACE_ENDPOINT = 'http://localhost:8000'
& node bin/agent-connector.js up --endpoint http://localhost:8000 *>> '$connectorLog'
"@

$backend = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $backendCmd) -WindowStyle Hidden -PassThru
$frontend = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $frontendCmd) -WindowStyle Hidden -PassThru
$connector = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $connectorCmd) -WindowStyle Hidden -PassThru
@{ backendPid = $backend.Id; frontendPid = $frontend.Id; connectorPid = $connector.Id } | ConvertTo-Json | Set-Content -Encoding UTF8 $statePath

function Wait-Http([string]$Url, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $r = Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec 3
            if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { return $true }
        } catch { Start-Sleep -Milliseconds 500 }
    } while ((Get-Date) -lt $deadline)
    return $false
}

Write-Host 'Starting backend (cold go run can take ~1 min to compile)...' -ForegroundColor Cyan
if (-not (Wait-Http 'http://localhost:8000/v1/health' 150)) {
    Stop-Managed; throw "Backend did not become ready. See $backendLog"
}
Write-Host 'Backend ready on http://localhost:8000' -ForegroundColor Green
if (-not (Wait-Http 'http://localhost:3005/' 90)) {
    Write-Host "Frontend still starting — check $frontendLog" -ForegroundColor Yellow
} else {
    Write-Host 'Frontend ready on http://localhost:3005' -ForegroundColor Green
}
Write-Host ''
Write-Host 'Local dev is up:' -ForegroundColor Green
Write-Host '  Frontend: http://localhost:3005'
Write-Host '  Backend:  http://localhost:8000/v1/health'
Write-Host "  Data/logs: $runtimePath"
Write-Host 'Stop with: .\workspace\dev-sqlite.ps1 -Stop'

# Keep process alive so background task job object does not terminate child processes
while ($true) { Start-Sleep -Seconds 5 }

