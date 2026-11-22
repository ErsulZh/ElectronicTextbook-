@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "NO_PAUSE=0"
if /i "%~1"=="--from-start" set "NO_PAUSE=1"

if not exist "package.json" (
  echo Project files were not found. Extract the whole archive before running this file.
  goto :failed
)

if not exist "package-lock.json" (
  echo package-lock.json was not found. Extract the whole archive before running this file.
  goto :failed
)

call "%~dp0ensure-node.bat" modern
if errorlevel 1 (
  echo Node.js could not be prepared automatically.
  goto :failed
)
set "PATH=%TEXTBOOK_NODE_DIR%;%PATH%"

echo Installing the electronic textbook site. This can take a few minutes on the first run.
call "%TEXTBOOK_NODE_DIR%npm.cmd" ci
if errorlevel 1 (
  echo Dependencies could not be installed. Check the internet connection and run this file again.
  goto :failed
)

"%TEXTBOOK_NODE_EXE%" --check server.js >nul
if errorlevel 1 (
  echo The server file could not be verified.
  goto :failed
)
"%TEXTBOOK_NODE_EXE%" --check src\app.js >nul
if errorlevel 1 (
  echo The reader file could not be verified.
  goto :failed
)

echo.
echo Installation completed. You can now run start-site.bat.
if "%NO_PAUSE%"=="0" pause
exit /b 0

:failed
if "%NO_PAUSE%"=="0" pause
exit /b 1
