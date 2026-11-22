@echo off
setlocal EnableExtensions
cd /d "%~dp0"

call "%~dp0ensure-node.bat" modern
if errorlevel 1 (
  echo Node.js could not be prepared automatically.
  pause
  exit /b 1
)
set "PATH=%TEXTBOOK_NODE_DIR%;%PATH%"

if not exist "node_modules\mammoth\package.json" (
  echo Site dependencies are not installed. Starting the installer...
  call "%~dp0install-site.bat" --from-start
  if errorlevel 1 (
    echo The site could not be prepared. Run install-site.bat again after fixing the problem.
    pause
    exit /b 1
  )
)

"%TEXTBOOK_NODE_EXE%" server.js
if errorlevel 1 pause
