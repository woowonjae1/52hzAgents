# 52hzAgents Desktop Automated Build Pipeline
# Usage: .\workspace\build-desktop.ps1 [-Target installer|dir]

param (
    [string]$Target = "dir"
)

$ErrorActionPreference = "Stop"
$WorkspaceRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

# Set domestic fast mirror for Electron binary downloads
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "  52hzAgents Zero-Config Desktop Build Pipeline  " -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "Project Root: $WorkspaceRoot"

# 1. Prepare Target Directory Structure
$DesktopDir = Join-Path $WorkspaceRoot "workspace\desktop"
$ResourcesDir = Join-Path $DesktopDir "resources"
$BinDir = Join-Path $ResourcesDir "bin"
$PublicDir = Join-Path $ResourcesDir "public"
$WwjDir = Join-Path $ResourcesDir "wwj"

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
New-Item -ItemType Directory -Force -Path $PublicDir | Out-Null
New-Item -ItemType Directory -Force -Path $WwjDir | Out-Null

# 3. Copy WWJ Agent Connector (Node.js Engine for 17+ Adapters)
Write-Host "`n[1/4] Assembling WWJ Agent Connector..." -ForegroundColor Yellow
$WwjSource = Join-Path $WorkspaceRoot "packages\wwj"
Copy-Item -Recurse -Force (Join-Path $WwjSource "src") $WwjDir
Copy-Item -Recurse -Force (Join-Path $WwjSource "bin") $WwjDir
Copy-Item -Force (Join-Path $WwjSource "package.json") $WwjDir
if (Test-Path (Join-Path $WwjSource "registry.json")) {
    Copy-Item -Force (Join-Path $WwjSource "registry.json") $WwjDir
}
if (Test-Path (Join-Path $WwjSource "node_modules")) {
    Copy-Item -Recurse -Force (Join-Path $WwjSource "node_modules") $WwjDir
}
Write-Host "  -> WWJ Connector assembled." -ForegroundColor Green

# 4. Build Next.js Frontend
Write-Host "`n[2/4] Building Next.js Frontend..." -ForegroundColor Yellow
$FrontendDir = Join-Path $WorkspaceRoot "workspace\frontend"
$NextOut = Join-Path $FrontendDir "out"
Push-Location $FrontendDir
try {
    $NextOut = Join-Path $FrontendDir "out"
    $NextPublic = Join-Path $FrontendDir "public"

    # Drop any previous export first: if the build fails we must NOT silently
    # package yesterday's bundle.
    if (Test-Path $NextOut) {
        Remove-Item -Recurse -Force $NextOut
    }

    # $ErrorActionPreference = "Stop" turns ANY stderr line from a native command
    # (including harmless next build warnings) into a terminating NativeCommandError.
    # Relax it here and judge success by the real exit code instead.
    $PrevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    npm run build
    $BuildExit = $LASTEXITCODE
    $ErrorActionPreference = $PrevEAP

    if ($BuildExit -ne 0) {
        throw "next build failed with exit code $BuildExit - aborting instead of packaging a stale frontend."
    }
    if (-not (Test-Path $NextOut)) {
        throw "next build exited 0 but produced no 'out' directory (next.config.mjs uses output: 'export') - aborting."
    }

    # Copy exported / public assets
    if (Test-Path $NextPublic) {
        Copy-Item -Recurse -Force "$NextPublic\*" $PublicDir
    }
    Copy-Item -Recurse -Force "$NextOut\*" $PublicDir
    Write-Host "  -> Frontend assets ready in resources/public (built $(Get-Date -Format 'HH:mm:ss'))." -ForegroundColor Green
} finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
# THE GO BUILD MOVED BELOW THE FRONTEND BUILD ON PURPOSE.
#
# `internal/webui` embeds the export with //go:embed, and //go:embed is
# resolved by the COMPILER. Compiling the server before the frontend exists
# bakes in whatever was in that directory last time -- which on a clean
# checkout is the .gitkeep placeholder, i.e. a binary that serves the API and
# a 404 for every page, and reports success while doing it.
#
# The export is staged into internal/webui/dist (gitignored) rather than
# embedded from ../frontend/out directly, because //go:embed cannot reference
# anything outside its own package directory.
# ---------------------------------------------------------------------------
Write-Host "`n[3/4] Compiling Go Backend (52hz-server.exe, frontend embedded)..." -ForegroundColor Yellow
$BackendDir = Join-Path $WorkspaceRoot "workspace\backend"
$EmbedDir = Join-Path $BackendDir "internal\webui\dist"

# Clear everything except the placeholder, so a removed page cannot survive
# into the next binary as a stale embedded file.
if (Test-Path $EmbedDir) {
    Get-ChildItem -Path $EmbedDir -Force -Exclude ".gitkeep" | Remove-Item -Recurse -Force
} else {
    New-Item -ItemType Directory -Force -Path $EmbedDir | Out-Null
}
Copy-Item -Recurse -Force "$NextOut\*" $EmbedDir
Write-Host "  -> Staged $((Get-ChildItem $EmbedDir -Recurse -File).Count) files for embedding." -ForegroundColor DarkGray

Push-Location $BackendDir
try {
    $env:CGO_ENABLED = "0"
    $ServerExe = Join-Path $BinDir "52hz-server.exe"
    go build -ldflags="-s -w" -o $ServerExe ./cmd/server
    if (-not (Test-Path $ServerExe)) {
        throw "Failed to compile Go backend binary!"
    }
    Write-Host "  -> Successfully compiled 52hz-server.exe ($([math]::Round((Get-Item $ServerExe).Length / 1MB, 2)) MB, self-contained)" -ForegroundColor Green
} finally {
    Pop-Location
}

# 5. Package Electron Desktop App
Write-Host "`n[4/4] Packaging Electron Desktop App (Target: $Target)..." -ForegroundColor Yellow
try {
    Get-Process -Name 52hzAgents, electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
} catch {}
Start-Sleep -Milliseconds 800

$OutputDir = "$DesktopDir\release-dist"
for ($i = 0; $i -lt 5; $i++) {
    if (Test-Path "$OutputDir") {
        try {
            Remove-Item -Path "$OutputDir" -Recurse -Force -ErrorAction Stop
            break
        } catch {
            Start-Sleep -Milliseconds 1000
        }
    } else {
        break
    }
}

Push-Location $DesktopDir
try {
    if ($Target -eq "installer") {
        npx electron-builder --win nsis
    } else {
        npx electron-builder --dir
    }
    Write-Host "`n=================================================" -ForegroundColor Cyan
    Write-Host "  Build Completed Successfully!                  " -ForegroundColor Green
    Write-Host "  Output Directory: $DesktopDir\release-dist     " -ForegroundColor Green
    Write-Host "=================================================" -ForegroundColor Cyan
} finally {
    Pop-Location
}
