@echo off
chcp 65001 >nul
title MedionTime Relay (port 8789)
cd /d "%~dp0server"

REM --host 0.0.0.0 lets phones on the same Wi-Fi reach the relay.
REM Drop the flag to listen on 127.0.0.1 only.
node relay.mjs --host 0.0.0.0 --port 8789

echo.
echo The relay exited. Check the error message above.
pause
