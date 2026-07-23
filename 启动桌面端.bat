@echo off
title 52hzAgents 桌面端 (极速秒开模式)
cd /d "%~dp0packages\launcher"
echo 正在极速启动 52hzAgents 桌面端...
npx electron "%~dp0packages\launcher"
