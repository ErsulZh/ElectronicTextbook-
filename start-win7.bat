@echo off
setlocal EnableExtensions
cd /d "%~dp0"

call "%~dp0ensure-node.bat" win7
if errorlevel 1 (
  echo Node.js could not be prepared automatically.
  pause
  exit /b 1
)
set "PATH=%TEXTBOOK_NODE_DIR%;%PATH%"

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
"%TEXTBOOK_NODE_EXE%" server.js
if errorlevel 1 pause
