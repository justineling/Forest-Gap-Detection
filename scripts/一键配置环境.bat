@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"

rem ⚠️ 被「2. 构建安装包.bat」「1. 启动桌面端.bat」自动调用时必须跳过所有 pause：
rem    自动流程里没人按键，pause 会让整个构建**永久卡住**（2026-10-21 实测：
rem    用户等了 22 分钟，向导其实一步都没跑，只有心跳在刷屏）。
rem    调用方设置 FGD_NO_PAUSE=1 即可；手动双击时该变量不存在，行为不变。
rem ⚠️ 注意别用参数传：本文件第 35 行把 %* 原样转给 ps1，而 cmd 的 shift
rem    不影响 %*，多一个参数会让 ps1 报"无法识别的位置参数"。

rem 用通配符定位同目录下的 .ps1，避免在批处理里硬编码中文文件名
set "PSFILE="
for %%f in ("%~dp0*.ps1") do set "PSFILE=%%f"

if not defined PSFILE (
    echo.
    echo   [错误] 同目录下找不到 .ps1 脚本文件，请确认文件完整。
    echo.
    if not defined FGD_NO_PAUSE pause
    exit /b 1
)

echo.
echo  ====================================================================
echo        油棕园空地智能检测  -  环境配置向导
echo  ====================================================================
echo.
echo  即将开始检测并配置开发环境，请稍候...
echo.
echo   - 所有大体积文件（Python环境 / 缓存 / Rust工具链 / 模型）都会装到 D 盘
echo   - 多数组件无需管理员权限
echo   - 有独立显卡时自动装 GPU 版，没有才降级到 CPU 版
echo   - 长任务每 20 秒提示一次进度，不会卡死
echo.
echo  如果只想「看看现在装了哪些、还缺哪些」而不做任何安装，
echo  请改双击同目录下的「环境体检.bat」。
echo.
if not defined FGD_NO_PAUSE pause

powershell -NoProfile -ExecutionPolicy Bypass -File "%PSFILE%" %*

echo.
echo  ====================================================================
echo   执行完毕，上方为环境检测报告。
echo   报告文件： docs\05-环境与部署\环境检测报告-%COMPUTERNAME%.md
echo  ====================================================================
echo.
if not defined FGD_NO_PAUSE pause
