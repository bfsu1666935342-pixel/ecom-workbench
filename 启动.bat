@echo off
setlocal
cd /d "%~dp0"
title Ecom Workbench

if exist "runtime\node.exe" (
  set "NODE=runtime\node.exe"
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo  [ERROR] Node runtime not found.
    echo  Please make sure the folder "runtime" is next to this file.
    echo.
    pause
    exit /b 1
  )
  set "NODE=node"
)

echo.
echo   Starting Ecom Workbench...
echo   A browser window will open. Keep this window open while using.
echo.

"%NODE%" server\main.js
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo   Server exited with code %CODE%.
  pause
)
endlocal
