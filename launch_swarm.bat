@echo off
chcp 65001 > nul
title FORGEHAMMER - 16-Parallel Ore Swarm Client
cd /d "%~dp0legacy\ore-swarm"
node src\swarm.js
pause
