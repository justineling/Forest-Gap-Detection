@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"

echo.
echo  ====================================================================
echo   环境体检（只检测，不做任何安装 / 不修改系统）
echo  ====================================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_env.ps1" -CheckOnly %*

echo.
echo  报告文件： docs\environment-report.md
echo.
pause
