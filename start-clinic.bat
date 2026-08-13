@echo off
title ResQ Clinic Launcher
cd /d %userprofile%\Desktop\resq-app
set DATABASE_URL=postgresql://postgres:12345678@localhost:5432/resq_clinic_db
start "" cmd /c "node server.js"
timeout /t 2 >nul
start index.html