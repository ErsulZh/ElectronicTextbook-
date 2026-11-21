@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install a Windows 7 compatible Node.js 13.6 or newer first.
  pause
  exit /b 1
)

if not exist "win7-runtime\node_modules\mammoth\package.json" (
  echo Windows 7 runtime is not installed. Starting the installer...
  call "%~dp0install-win7.bat" --from-start
  if errorlevel 1 (
    echo The Windows 7 runtime could not be prepared. Run install-win7.bat again after fixing the problem.
    pause
    exit /b 1
  )
)

set "TEXTBOOK_WIN7_RUNTIME=1"
set "NODE_PATH=%~dp0win7-runtime\node_modules"
node server.js
if errorlevel 1 pause
