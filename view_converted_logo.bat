@echo off
chcp 65001 > nul
title FORGEHAMMER - Rasterized Logo Preview
cd /d "%~dp0tools\rasterizer"
call view_logo.bat
