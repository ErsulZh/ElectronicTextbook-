@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "NO_PAUSE=0"
if /i "%~1"=="--from-start" set "NO_PAUSE=1"

if not exist "server.js" (
  echo Project files were not found. Extract the whole archive before running this file.
  goto :failed
)
if not exist "win7-runtime\package-lock.json" (
  echo Windows 7 runtime files were not found. Extract the whole archive before running this file.
  goto :failed
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install a Windows 7 compatible Node.js 13.6 or newer, then run this file again.
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
if %NODE_MAJOR% LSS 13 goto :unsupported_node
if %NODE_MAJOR% EQU 13 if %NODE_MINOR% LSS 6 goto :unsupported_node

echo Installing the isolated Windows 7 compatibility runtime.
echo Keep the project in a short path such as C:\Textbook while installing.
pushd "win7-runtime"
call npm ci --ignore-scripts --no-audit
set "INSTALL_RESULT=%ERRORLEVEL%"
popd
if not "%INSTALL_RESULT%"=="0" (
  echo The Windows 7 runtime could not be installed. Check the internet connection and run this file again.
  goto :failed
)

if not exist "win7-runtime\node_modules\mammoth\package.json" (
  echo The required Word reader dependency is missing after installation.
  goto :failed
)
if not exist "win7-runtime\node_modules\pdfjs-dist\legacy\build\pdf.mjs" (
  echo The required legacy PDF reader dependency is missing after installation.
  goto :failed
)

set "TEXTBOOK_WIN7_RUNTIME=1"
node --check server.js >nul
if errorlevel 1 (
  echo The local server could not be verified with this Node.js version.
  goto :failed
)

echo.
echo Windows 7 compatibility runtime is ready. You can now run start-win7.bat.
if "%NO_PAUSE%"=="0" pause
exit /b 0

:unsupported_node
echo Node.js 13.6 or newer is required for this compatibility mode.

:failed
if "%NO_PAUSE%"=="0" pause
exit /b 1
