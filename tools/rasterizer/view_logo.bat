@echo off
chcp 65001 > nul
title FORGEHAMMER - Rasterized Logo Preview
cd /d "%~dp0"
type output_logo.ans
echo.
echo [FORGEHAMMER] Logo rendered in TrueColor ANSI.
pause
