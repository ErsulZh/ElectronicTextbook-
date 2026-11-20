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

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22.13 or newer, then run this file again.
  goto :failed
)

for /f "tokens=1,2 delims=." %%A in ('node -p "process.versions.node" 2^>nul') do (
  set "NODE_MAJOR=%%A"
  set "NODE_MINOR=%%B"
)
if not defined NODE_MAJOR (
  echo The installed Node.js version could not be checked.
  goto :failed
)
if %NODE_MAJOR% LSS 22 goto :unsupported_node
if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 13 goto :unsupported_node

echo Installing the electronic textbook site. This can take a few minutes on the first run.
call npm ci
if errorlevel 1 (
  echo Dependencies could not be installed. Check the internet connection and run this file again.
  goto :failed
)

node --check server.js >nul
if errorlevel 1 (
  echo The server file could not be verified.
  goto :failed
)
node --check src\app.js >nul
if errorlevel 1 (
  echo The reader file could not be verified.
  goto :failed
)

echo.
echo Installation completed. You can now run start-site.bat.
if "%NO_PAUSE%"=="0" pause
exit /b 0

:unsupported_node
echo Node.js 22.13 or newer is required. Update Node.js, then run this file again.

:failed
if "%NO_PAUSE%"=="0" pause
exit /b 1
