@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Установите Node.js LTS, затем снова запустите этот файл.
  pause
  exit /b 1
)

node server.js
if errorlevel 1 pause
