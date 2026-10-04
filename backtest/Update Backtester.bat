@echo off
rem Backtester: download the latest version (your data, results, settings and presets are kept).
cd /d "%~dp0"
git pull
if errorlevel 1 ( echo Update failed. & pause & exit /b 1 )
call npm install --no-audit --no-fund
echo Up to date. Start the app with "Start Backtester.bat".
pause
