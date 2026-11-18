@echo off
chcp 65001 >nul
setlocal

set "PORT=7861"

echo.
echo   正在停止工作台（端口 %PORT%）...
echo.

set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT%" ^| findstr /i "LISTENING"') do (
  set "FOUND=1"
  echo   结束进程 %%P
  taskkill /pid %%P /f >nul 2>&1
)

if not defined FOUND (
  echo   端口 %PORT% 上没有在跑的服务。
) else (
  echo.
  echo   已停止。下次点桌面的「跨境 AI 工作台」重新启动。
)

echo.
pause
