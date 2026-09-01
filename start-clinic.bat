@echo off
title RESQ Clinic Management System
cd /d "%~dp0"
echo Starting RESQ Clinic System...
start http://localhost:10000
node server.js
pause