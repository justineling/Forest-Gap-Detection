@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"

echo.
echo  ====================================================================
echo        油棕园空地智能检测  -  环境配置向导
echo  ====================================================================
echo.
echo  即将开始检测并配置开发环境...
echo   - 所有大体积文件（Python环境 / 缓存 / Rust工具链 / 模型）都会装到 D 盘
echo   - 多数组件无需管理员权限
echo   - 长任务每 20 秒会提示一次进度，不会卡死
echo.
echo  如果只想"看看现在装了哪些、还缺哪些"而不做任何安装，
echo  请改运行同目录下的： check_env.bat
echo.
pause

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_env.ps1" %*

echo.
echo  ====================================================================
echo   执行完毕。上方为环境检测报告。
echo   报告文件： docs\environment-report.md
echo  ====================================================================
echo.
pause
