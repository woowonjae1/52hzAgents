$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop)
$Shortcut = $WshShell.CreateShortcut("$DesktopPath\52hzAgents.lnk")
$unpackedDir = Join-Path $PSScriptRoot "release-dist\win-unpacked"
$Shortcut.TargetPath = Join-Path $unpackedDir "52hzAgents.exe"
$Shortcut.WorkingDirectory = $unpackedDir
$Shortcut.IconLocation = Join-Path $PSScriptRoot "icon.ico"
$Shortcut.Description = "52hzAgents Local-First Multi-Agent Orchestration Workspace"
$Shortcut.Save()
Write-Host "Shortcut created at $DesktopPath\52hzAgents.lnk"
