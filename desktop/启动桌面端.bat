@echo off
chcp 65001 >nul
title Forest Gap Detection - 桌面端
cd /d "%~dp0"
setlocal EnableExtensions

echo.
echo  ====================================================
echo    Forest Gap Detection - 桌面端启动器（开发向）
echo    油棕园空地智能检测
echo  ====================================================
echo.

rem ---- 自愈：项目文件夹被移动过 → 清掉失效的编译缓存 ----
call "%~dp0_环境准备.bat" detect_move
if errorlevel 1 exit /b 1

rem ============================================================
rem  阶段 1/5：检查运行环境（Python venv / 前端依赖 / Rust）
rem ============================================================
call "%~dp0_环境准备.bat" stage_begin 1 5 "检查运行环境"
call "%~dp0_环境准备.bat" check_runtime
call "%~dp0_环境准备.bat" stage_end
if defined FG_NEED_PY goto :need_setup
if defined FG_NEED_NPM goto :need_setup
if defined FG_NEED_RUST goto :need_setup
goto :stage2_ready


:need_setup
rem ============================================================
rem  阶段 2/5：自动补齐环境（复用项目自带的配置向导）
rem ============================================================
call "%~dp0_环境准备.bat" stage_begin 2 5 "自动补齐缺失环境"
echo.
echo   检测到环境不完整，将调用项目自带的「一键配置环境」向导。
echo   它会完成：系统检测 → 工具链安装 → GPU 检测 → Python venv + 依赖
echo             → 模型权重 + 前端依赖
echo.
echo   预计耗时：5 到 15 分钟（首次较久；期间会持续输出进度，请勿关闭窗口）。
echo.
call "%~dp0_环境准备.bat" start_heartbeat "仍在配置环境" 40
call "%~dp0_环境准备.bat" ensure_python_env
set "FG_RC=%ERRORLEVEL%"
call "%~dp0_环境准备.bat" stop_heartbeat
if not "%FG_RC%"=="0" goto :setup_fail

rem 装完重新检测（PATH 是启动时的旧快照，需刷新）
call "%~dp0_环境准备.bat" check_runtime
if defined FG_NEED_PY goto :setup_still_missing
if defined FG_NEED_RUST goto :setup_still_missing
call "%~dp0_环境准备.bat" ensure_npm
if errorlevel 1 goto :npm_fail
call "%~dp0_环境准备.bat" stage_end
goto :stage3


:stage2_ready
call "%~dp0_环境准备.bat" stage_begin 2 5 "自动补齐缺失环境"
echo   环境完整，无需安装。
call "%~dp0_环境准备.bat" stage_end
goto :stage3


:stage3
rem ============================================================
rem  阶段 3/5：检查影像数据与瓦片服务端口
rem ============================================================
call "%~dp0_环境准备.bat" stage_begin 3 5 "检查影像数据与瓦片服务"

rem ---- 正射影像：缺失不阻断（前端仍可看多边形），但要明确告知 ----
if exist "..\drone data\WGR17-002.tif" (
    echo   [已就绪] 正射影像 drone data\WGR17-002.tif
) else if exist "..\drone data\WGR17.tif" (
    echo   [已就绪] 正射影像 drone data\WGR17.tif
) else (
    echo   [提示]   没找到正射影像（drone data\WGR17-002.tif）。
    echo            应用仍可启动：能查看/编辑多边形、估算株数、导出点位，
    echo            只是地图上没有影像底图。把影像放到 drone data\ 后重启即可。
)

rem ---- 瓦片服务端口 8765：被占则说明有残留进程，提示但不阻断 ----
call "%~dp0_环境准备.bat" port_free 8765
if errorlevel 1 (
    echo.
    echo   [提示] 端口 8765 已被占用（可能是上次没退干净的瓦片服务）。
    echo          应用会**复用**那个进程 —— 如果你刚改过 tile_server.py，
    echo          改动不会生效。建议先结束它：
    call "%~dp0_环境准备.bat" kill_port_owner 8765
    echo.
)
call "%~dp0_环境准备.bat" stage_end
goto :stage4


:stage4
rem ============================================================
rem  阶段 4/5：挑选前端开发端口（5173 被占则自动换）
rem  ⚠️ vite.config 的 strictPort=true 会在端口被占时**直接失败**，而
rem     tauri.conf.json 的 devUrl 写死 5173 —— 所以换端口必须两边同时改：
rem     用一份临时 tauri 配置（--config）覆盖 devUrl 与 beforeDevCommand。
rem     5173 空闲时完全走老路径（不加任何参数）。
rem ============================================================
call "%~dp0_环境准备.bat" stage_begin 4 5 "挑选前端开发端口"
call "%~dp0_环境准备.bat" pick_port 5173 27 FG_DEV_PORT
if not defined FG_DEV_PORT goto :port_fail
echo   界面地址：http://localhost:%FG_DEV_PORT%

set "FG_DEV_CFG="
if "%FG_DEV_PORT%"=="5173" goto :dev_port_ready
set "FG_DEV_CFG=%TEMP%\fgd-dev-port-%FG_DEV_PORT%.json"
del /q "%FG_DEV_CFG%" >nul 2>nul
> "%FG_DEV_CFG%" echo {"build":{"devUrl":"http://localhost:%FG_DEV_PORT%","beforeDevCommand":"npm run dev -- --port %FG_DEV_PORT%"}}
echo   5173 被占用，已改用 %FG_DEV_PORT%（已生成临时配置覆盖 devUrl）
:dev_port_ready
call "%~dp0_环境准备.bat" stage_end
goto :stage5


:stage5
rem ============================================================
rem  阶段 5/5：编译并启动桌面应用
rem ============================================================
call "%~dp0_环境准备.bat" stage_begin 5 5 "编译并启动桌面应用"
echo.
echo  ----------------------------------------------------
echo   请注意：
echo     1. 第一次启动要编译整个 Rust 外壳，大约 10 到 20 分钟。
echo        前端构建约 10~30 秒；Rust 编译约 5~15 分钟；
echo        最后「链接」阶段可能几分钟完全没输出，属正常，千万别关窗口。
echo     2. 第二次之后启动通常几十秒。
echo     3. 使用期间请保持这个黑色窗口开着。
echo     4. 用完直接关掉这个窗口即可（会自动清理瓦片服务子进程）。
echo  ----------------------------------------------------
echo.

call "%~dp0_环境准备.bat" mark_project_path

rem 心跳只覆盖首次编译那段（限时 25 分钟，编译完自动停，避免运行期刷屏）
call "%~dp0_环境准备.bat" start_heartbeat "首次编译较慢，仍在进行" 25
set "FG_DEV_RC=0"
if defined FG_DEV_CFG (
    call npm run tauri:dev -- --config "%FG_DEV_CFG%"
    if errorlevel 1 set "FG_DEV_RC=1"
) else (
    call npm run tauri:dev
    if errorlevel 1 set "FG_DEV_RC=1"
)
call "%~dp0_环境准备.bat" stop_heartbeat
if defined FG_DEV_CFG del /q "%FG_DEV_CFG%" >nul 2>nul
if not "%FG_DEV_RC%"=="0" goto :tauri_fail

echo.
echo  已退出。可以关闭这个窗口了。
pause
exit /b 0


rem ====================================================================
rem  错误处理
rem ====================================================================

:setup_fail
call "%~dp0_环境准备.bat" stop_heartbeat
echo.
echo  ====================================================
echo   [错误] 环境配置未完成
echo  ====================================================
call "%~dp0_环境准备.bat" why_python
pause
exit /b 1


:setup_still_missing
echo.
echo  ====================================================
echo   组件已安装，但仍检测不到
echo  ====================================================
echo.
echo   常见原因：本次会话的 PATH 还是启动时的旧快照。
echo   处理办法：**关掉这个窗口，重新双击「启动桌面端.bat」**。
echo.
echo   若重新打开后仍缺：
echo     · Rust：手动运行 rustup 安装并设置默认工具链（rustup default stable）
echo     · Python：确认已装 3.11+ 且勾选了「Add to PATH」
echo.
pause
exit /b 1


:npm_fail
call "%~dp0_环境准备.bat" stop_heartbeat
echo.
echo  ====================================================
echo   [错误] 前端依赖安装失败（npm install）
echo  ====================================================
echo.
echo  可能原因：网络不通 / 需要代理 / 磁盘空间不足 / node_modules 被占用。
echo  处理办法：删掉 desktop\node_modules 后重新运行本脚本。
echo.
pause
exit /b 1


:port_fail
echo.
echo  ====================================================
echo   [错误] 找不到可用的前端开发端口
echo  ====================================================
echo   5173 到 5199 全部被占用。
echo.
echo   处理办法：
echo     · 关闭占用端口的程序（netstat -ano ^| findstr LISTENING 查 PID）
echo     · 或重启电脑释放残留的开发服务器进程
echo.
pause
exit /b 1


:tauri_fail
call "%~dp0_环境准备.bat" stop_heartbeat
echo.
echo  ====================================================
echo   [错误] 桌面应用启动失败（npm run tauri:dev）
echo  ====================================================
call "%~dp0_环境准备.bat" why_tauri
pause
exit /b 1
