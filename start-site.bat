@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22.13 or newer, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\mammoth\package.json" (
  echo Site dependencies are not installed. Starting the installer...
  call "%~dp0install-site.bat" --from-start
  if errorlevel 1 (
    echo The site could not be prepared. Run install-site.bat again after fixing the problem.
    pause
    exit /b 1
  )
)

node server.js
if errorlevel 1 pause
