@echo off
title RESQ Clinic & Diagnostic Imaging Management System
color 1F

echo ====================================================================
echo        RESQ CLINIC & DIAGNOSTIC IMAGING MANAGEMENT SYSTEM           
echo ====================================================================
echo.
echo [1/3] Initializing Node.js Express Server...
start /B node server.js > clinic_server.log 2>&1

echo [2/3] Waiting for database connection pool...
timeout /t 2 /nobreak >nul

echo [3/3] Launching Desktop Window Workspace...
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=http://localhost:10000 --window-size=1440,900
) else if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
    start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=http://localhost:10000 --window-size=1440,900
) else (
    start http://localhost:10000
)

echo.
echo Application online at http://localhost:10000. Keep this window open.
pause