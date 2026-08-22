@echo off
title RESQ Clinic System Launcher
cd /d "%~dp0"

:: Automatically opens your default browser to the app
start "" "http://localhost:10000"

:: Runs the server
node server.js
pause