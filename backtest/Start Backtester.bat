@echo off
rem Backtester: double-click to start. It opens in your browser; close this window to stop it.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and double-click this file again.
  start "" https://nodejs.org
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%a in ('node -v') do set NODEMAJOR=%%a
set NODEMAJOR=%NODEMAJOR:v=%
if %NODEMAJOR% LSS 22 (
  echo Node.js 22 or newer is needed. Install the LTS version from https://nodejs.org and try again.
  start "" https://nodejs.org
  pause
  exit /b 1
)
if not exist "node_modules\@duckdb\node-api" (
  echo First start: installing components, this takes a minute...
  call npm install --no-audit --no-fund
  if errorlevel 1 ( pause & exit /b 1 )
)
node --experimental-strip-types --no-warnings src\cli.ts app
pause
