$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop)
$Shortcut = $WshShell.CreateShortcut("$DesktopPath\52hzAgents.lnk")
$Shortcut.TargetPath = "D:\code\52hzAgent\openagents-develop\workspace\desktop\release-dist\win-unpacked\52hzAgents.exe"
$Shortcut.WorkingDirectory = "D:\code\52hzAgent\openagents-develop\workspace\desktop\release-dist\win-unpacked"
$Shortcut.IconLocation = "D:\code\52hzAgent\openagents-develop\workspace\desktop\icon.ico"
$Shortcut.Description = "52hzAgents Local-First Multi-Agent Orchestration Workspace"
$Shortcut.Save()
Write-Host "Shortcut created at $DesktopPath\52hzAgents.lnk"
