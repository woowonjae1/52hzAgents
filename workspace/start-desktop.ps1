# 52hzAgents Desktop App Startup Script
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   Starting 52hzAgents Desktop Client   " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Step 1: Ensure backend and frontend stack are running
try {
  $status = (Invoke-WebRequest "http://localhost:3005" -UseBasicParsing -TimeoutSec 2).StatusCode
  if ($status -eq 200) {
    Write-Host "[Desktop Launcher] Web app server is online on http://localhost:3005." -ForegroundColor Green
  }
} catch {
  Write-Host "[Desktop Launcher] Starting backend & frontend stack via dev-sqlite.ps1..." -ForegroundColor Yellow
  Start-Process powershell.exe -ArgumentList "-ExecutionPolicy Bypass -File `"$ScriptDir\dev-sqlite.ps1`"" -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

# Step 2: Launch Electron Window wrapping current web app
Write-Host "[Desktop Launcher] Opening 52hzAgents Desktop Window..." -ForegroundColor Green
Set-Location "$ScriptDir\desktop"
npx electron .
