# 52hzAgents Desktop Launch Script
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   Starting 52hzAgents Desktop App     " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Check if local backend is online
try {
  $status = (Invoke-WebRequest "http://127.0.0.1:3005" -UseBasicParsing -TimeoutSec 2).StatusCode
  if ($status -lt 400) {
    Write-Host "[Desktop Launcher] Local web stack is online at http://127.0.0.1:3005." -ForegroundColor Green
  }
} catch {
  Write-Host "[Desktop Launcher] Starting backend & frontend stack in background..." -ForegroundColor Yellow
  Start-Process powershell.exe -ArgumentList "-ExecutionPolicy Bypass -File `"$ScriptDir\dev-sqlite.ps1`"" -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

# Launch Electron desktop client
Write-Host "[Desktop Launcher] Opening 52hzAgents Desktop App..." -ForegroundColor Green
Set-Location "$ScriptDir\desktop"
npx electron .
