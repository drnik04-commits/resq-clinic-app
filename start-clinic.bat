@echo off
title RESQ Clinic System Launcher
set NODE_SKIP_PLATFORM_CHECK=1

:: Start the Node server in background
start /B node server.js

:: Wait 2 seconds for server initialization
timeout /t 2 /nobreak >nul

:: Launch browser directly in app window mode (looks like a native desktop app)
start chrome.exe --app=http://localhost:3000 || start msedge.exe --app=http://localhost:3000 || start http://localhost:3000

exit