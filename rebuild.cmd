@echo off
REM 一键重建并推送（绕过 PowerShell 执行策略限制）
REM 用法：双击本文件，或在本目录执行 rebuild.cmd
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rebuild.ps1" %*
if errorlevel 1 (
  echo.
  echo [rebuild] 失败，请检查上面的输出。
  pause
  exit /b 1
)
echo.
echo [rebuild] 完成：去 FlClash - 脚本 - 同步
pause
