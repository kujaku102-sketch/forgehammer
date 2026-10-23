@echo off
chcp 65001 > nul
title FORGEHAMMER - Cyber-Anvil Operator
cd /d "%~dp0"
"%~dp0target\release\forge_tui.exe"
pause
