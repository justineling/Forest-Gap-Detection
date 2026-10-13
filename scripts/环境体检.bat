@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"

rem 用通配符定位同目录下的 .ps1，避免在批处理里硬编码中文文件名
set "PSFILE="
for %%f in ("%~dp0*.ps1") do set "PSFILE=%%f"

if not defined PSFILE (
    echo.
    echo   [错误] 同目录下找不到 .ps1 脚本文件，请确认文件完整。
    echo.
    pause
    exit /b 1
)

echo.
echo  ====================================================================
echo   环境体检（只检测，不做任何安装、不修改系统）
echo  ====================================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%PSFILE%" -CheckOnly %*

echo.
echo  报告文件： docs\environment-report.md
echo.
pause
