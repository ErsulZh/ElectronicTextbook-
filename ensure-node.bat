@echo off
setlocal EnableExtensions

set "TEXTBOOK_NODE_EXE="
set "TEXTBOOK_NODE_DIR="
set "NODE_MAJOR="
set "NODE_MINOR="
set "MODE=%~1"

if /i "%MODE%"=="modern" (
  set "NODE_VERSION=22.13.1"
  set "MIN_MAJOR=22"
  set "MIN_MINOR=13"
) else if /i "%MODE%"=="win7" (
  set "NODE_VERSION=13.6.0"
  set "MIN_MAJOR=13"
  set "MIN_MINOR=6"
) else (
  echo Internal installer error: unknown Node.js mode.
  goto :failed
)

call :find_node
if defined TEXTBOOK_NODE_EXE (
  call :read_version
  call :version_is_supported
  if not errorlevel 1 goto :ready
)

call :detect_architecture
if /i "%MODE%"=="win7" if /i "%NODE_ARCH%"=="arm64" (
  echo Windows 7 mode does not support ARM64 computers.
  goto :failed
)

set "NODE_INSTALLER=%TEMP%\electronic-textbook-node-v%NODE_VERSION%-%NODE_ARCH%.msi"
set "NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/node-v%NODE_VERSION%-%NODE_ARCH%.msi"
echo Downloading the required official Node.js v%NODE_VERSION% installer...

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol = 3072; Invoke-WebRequest -UseBasicParsing -Uri '%NODE_URL%' -OutFile '%NODE_INSTALLER%'"
if not errorlevel 1 goto :install_node

echo PowerShell download failed. Trying the Windows Background Intelligent Transfer Service...
where bitsadmin >nul 2>nul
if errorlevel 1 goto :download_failed
bitsadmin /transfer "ElectronicTextbookNode" /download /priority normal "%NODE_URL%" "%NODE_INSTALLER%"
if errorlevel 1 goto :download_failed

:install_node
if not exist "%NODE_INSTALLER%" goto :download_failed
echo Installing Node.js. Approve the Windows administrator prompt if it appears.
msiexec.exe /i "%NODE_INSTALLER%" /passive /norestart
set "MSI_RESULT=%ERRORLEVEL%"
del /q "%NODE_INSTALLER%" >nul 2>nul
if "%MSI_RESULT%"=="0" goto :locate_installed
if "%MSI_RESULT%"=="3010" goto :locate_installed
echo Node.js installer returned error code %MSI_RESULT%.
goto :failed

:locate_installed
set "TEXTBOOK_NODE_EXE="
if exist "%ProgramFiles%\nodejs\node.exe" set "TEXTBOOK_NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined TEXTBOOK_NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "TEXTBOOK_NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined TEXTBOOK_NODE_EXE call :find_node
if not defined TEXTBOOK_NODE_EXE (
  echo Node.js was installed, but node.exe could not be found. Restart Windows and run this file again.
  goto :failed
)
call :read_version
call :version_is_supported
if errorlevel 1 (
  echo Installed Node.js does not meet the required version.
  goto :failed
)

:ready
for %%I in ("%TEXTBOOK_NODE_EXE%") do set "TEXTBOOK_NODE_DIR=%%~dpI"
endlocal & set "TEXTBOOK_NODE_EXE=%TEXTBOOK_NODE_EXE%" & set "TEXTBOOK_NODE_DIR=%TEXTBOOK_NODE_DIR%" & exit /b 0

:find_node
set "TEXTBOOK_NODE_EXE="
for /f "delims=" %%I in ('where node 2^>nul') do if not defined TEXTBOOK_NODE_EXE set "TEXTBOOK_NODE_EXE=%%I"
exit /b 0

:read_version
set "NODE_MAJOR="
set "NODE_MINOR="
for /f "tokens=1,2 delims=." %%A in ('"%TEXTBOOK_NODE_EXE%" --version 2^>nul') do (
  set "NODE_MAJOR=%%A"
  set "NODE_MINOR=%%B"
)
set "NODE_MAJOR=%NODE_MAJOR:v=%"
exit /b 0

:version_is_supported
if not defined NODE_MAJOR exit /b 1
if %NODE_MAJOR% GTR %MIN_MAJOR% exit /b 0
if %NODE_MAJOR% LSS %MIN_MAJOR% exit /b 1
if %NODE_MINOR% GEQ %MIN_MINOR% exit /b 0
exit /b 1

:detect_architecture
set "NODE_ARCH=x86"
if /i "%PROCESSOR_ARCHITECTURE%"=="AMD64" set "NODE_ARCH=x64"
if /i "%PROCESSOR_ARCHITEW6432%"=="AMD64" set "NODE_ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "NODE_ARCH=arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "NODE_ARCH=arm64"
exit /b 0

:download_failed
echo Node.js could not be downloaded. Check the internet connection and Windows TLS updates, then run this file again.

:failed
endlocal & exit /b 1
