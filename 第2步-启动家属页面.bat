@echo off
chcp 65001 >nul
title MedionTime caregiver page (port 8788)
cd /d "%~dp0app"

REM Serves the patient PWA and the caregiver page over HTTP,
REM which is required for Service Worker / PWA install.
python -m http.server 8788 --bind 0.0.0.0

echo.
echo The page server exited. Check the error message above.
pause
