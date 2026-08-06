@echo off
title 52hzAgents 桌面端 (极速秒开模式)
cd /d "%~dp0packages\launcher"
if not exist "%~dp0packages\launcher\out\renderer\index.html" (
    echo 首次启动，正在为您编译桌面端 UI...
    call npm run build
)
echo 正在极速启动 52hzAgents 桌面端...
"%~dp0packages\launcher\node_modules\.bin\electron.cmd" "%~dp0packages\launcher"
