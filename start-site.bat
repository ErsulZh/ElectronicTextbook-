@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js LTS, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\mammoth\package.json" (
  echo First launch: installing site dependencies...
  call npm ci
  if errorlevel 1 (
    echo Could not install dependencies. Check the internet connection and try again.
    pause
    exit /b 1
  )
)

node server.js
if errorlevel 1 pause
