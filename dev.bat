@echo off
setlocal
cd /d "%~dp0"
title Ecom Workbench (dev)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ERROR] Node.js not found on PATH.
  echo  Install Node.js 22+ for development, or run 打包.ps1 to download the runtime.
  echo.
  pause
  exit /b 1
)

echo.
echo   Ecom Workbench dev server
echo   Keep this window open. Ctrl+C to stop.
echo.
node server\main.js
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo   Server exited with code %CODE%.
  pause
)
endlocal
