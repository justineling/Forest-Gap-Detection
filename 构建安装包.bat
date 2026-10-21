@echo off
chcp 65001 >nul
title Forest Gap Detection - 构建安装包
cd /d "%~dp0"
setlocal EnableExtensions

echo.
echo  ====================================================
echo    Forest Gap Detection - 构建安装包（发布者向）
echo    油棕园空地智能检测
echo  ====================================================
echo.

rem ---- 自愈：项目文件夹被移动过 → 清掉失效的编译缓存 ----
call "%~dp0_环境准备.bat" detect_move
if errorlevel 1 exit /b 1

rem 产物根目录：尊重 CARGO_TARGET_DIR（本机指到 D:\forest-gap-tools\rust\target）
call "%~dp0_环境准备.bat" resolve_target_dir
rem FG_REL / FG_STALE_DIR 在 :prepare_build_env 之后才最终确定（见阶段 4）

rem ============================================================
rem  阶段 1/5：检查构建环境（Python venv / 前端依赖 / Rust）
rem  ⚠️ 构建期不需要 WebView2 —— 那是终端用户「运行」时的依赖。
rem ============================================================
call "%~dp0_环境准备.bat" stage_begin 1 5 "检查构建环境"
call "%~dp0_环境准备.bat" check_runtime
call "%~dp0_环境准备.bat" stage_end
if defined FG_NEED_PY goto :need_setup
if defined FG_NEED_NPM goto :need_setup
if defined FG_NEED_RUST goto :need_setup
goto :stage2_ready


:need_setup
call "%~dp0_环境准备.bat" stage_begin 2 5 "自动补齐缺失环境"
echo.
echo   检测到环境不完整，将调用项目自带的「一键配置环境」向导（约 5~15 分钟）。
echo.
call "%~dp0_环境准备.bat" start_heartbeat "仍在配置环境" 40
call "%~dp0_环境准备.bat" ensure_python_env
set "FG_RC=%ERRORLEVEL%"
call "%~dp0_环境准备.bat" stop_heartbeat
if not "%FG_RC%"=="0" goto :setup_fail
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
rem  阶段 3/5：生成前端产物（dist/）
rem ============================================================
rem ⚠️ 硬门槛：缺 MSVC 一定打不出安装包（GNU 工具链编不了 Tauri）。
rem    在这里提前阻断并给出下载地址，别让用户等编译几分钟才看到 link.exe 报错。
call "%~dp0_环境准备.bat" ensure_msvc
if errorlevel 1 goto :msvc_fail
call "%~dp0_环境准备.bat" stage_begin 3 5 "生成前端产物"
echo   正在构建前端（tsc 类型检查 + vite build，约 10~30 秒）...
call "%~dp0_环境准备.bat" start_heartbeat "仍在构建前端" 10
pushd "%~dp0desktop"
call npm run build
set "FG_RC=%ERRORLEVEL%"
popd
call "%~dp0_环境准备.bat" stop_heartbeat
if not "%FG_RC%"=="0" goto :build_front_fail
call "%~dp0_环境准备.bat" stage_end
goto :stage4


:stage4
rem ============================================================
rem  阶段 4/5：打包 Python 运行时（PyInstaller → py-runtime\desktop_entry）
rem  ⚠️ 缺了这一步，安装包里的 py-runtime 只有一个 .gitkeep —— 装出来的包
rem     必然缺瓦片服务。历史上靠"先手工跑一次 ps1"，很容易漏（2026-10-21 补进流程）。
rem ============================================================
call "%~dp0_环境准备.bat" stage_begin 4 5 "打包 Python 运行时"
call "%~dp0_环境准备.bat" ensure_py_runtime
if errorlevel 1 goto :runtime_fail
call "%~dp0_环境准备.bat" stage_end
goto :stage5


:stage5
rem ============================================================
rem  阶段 5/5：构建安装包（tauri build）
rem ============================================================
call "%~dp0_环境准备.bat" stage_begin 5 5 "构建安装包"
echo.
echo  ----------------------------------------------------
echo   请注意：
echo     1. 首次构建要编译整个 Rust 外壳，约 10 到 20 分钟。
echo     2. 构建完成后，安装包会生成在下方报告的目录里。
echo     3. 构建期需要联网（首次会下载 NSIS / WiX 打包工具）；
echo        WebView2 由安装包在**安装时**联网下载。
echo  ----------------------------------------------------
echo.


rem 中和 CARGO_TARGET_DIR：安装包产物固定到项目内
rem   desktop\src-tauri\target\release\bundle\nsis\
call "%~dp0_环境准备.bat" prepare_build_env
set "FG_REL=%FG_TARGET%\release"
set "FG_STALE_DIR=%FG_REL%\bundle\_stale"
rem ---- 关键：构建前把上一次的旧安装包挪走（不删除，移到 _stale）----
rem 目的：让构建后的查找**只可能**命中本次产物。零命中即「本次没产出」，
rem       杜绝「报告 / 弹出上一次的旧包」这种最坑的误报。
call "%~dp0_环境准备.bat" park_stale "%FG_REL%\bundle\nsis\*.exe" "%FG_STALE_DIR%"
call "%~dp0_环境准备.bat" park_stale "%FG_REL%\bundle\msi\*.msi" "%FG_STALE_DIR%"
call "%~dp0_环境准备.bat" mark_project_path
call "%~dp0_环境准备.bat" start_heartbeat "仍在构建（链接阶段可能较久）" 40
pushd "%~dp0desktop"
call npm run tauri:build
set "FG_RC=%ERRORLEVEL%"
popd
call "%~dp0_环境准备.bat" stop_heartbeat
if not "%FG_RC%"=="0" goto :build_fail
call "%~dp0_环境准备.bat" stage_end
goto :report


:report
echo.
echo  ====================================================
echo   构建完成
echo  ====================================================
echo.
call :show_artifacts
echo.
call :launch_installer
echo.
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
echo   处理办法：关掉这个窗口，重新双击「构建安装包.bat」。
echo   （本次会话的 PATH 还是启动时的旧快照）
echo.
pause
exit /b 1


:npm_fail
call "%~dp0_环境准备.bat" stop_heartbeat
echo.
echo  ====================================================
echo   [错误] 前端依赖安装失败（npm install）
echo  ====================================================
echo   处理办法：删掉 desktop\node_modules 后重新运行本脚本。
echo.
pause
exit /b 1


:msvc_fail
call "%~dp0_环境准备.bat" stop_heartbeat
echo  ====================================================
echo   构建已中止：缺少 MSVC C++ 生成工具
echo  ====================================================
echo   按上面给出的步骤装好「使用 C++ 的桌面开发」后，重新双击本脚本即可。
echo   Python / Rust / 前端依赖已经配好，重跑会自动跳过它们。
echo.
pause
exit /b 1


:build_front_fail
call "%~dp0_环境准备.bat" stop_heartbeat
echo.
echo  ====================================================
echo   [错误] 前端构建失败（npm run build）
echo  ====================================================
echo   通常是 TypeScript 类型错误或 vite 配置问题，请查看上方报错。
echo   本地快速自查：cd desktop ^&^& npx tsc --noEmit
echo.
pause
exit /b 1


:runtime_fail
call "%~dp0_环境准备.bat" stop_heartbeat
echo.
echo  ====================================================
echo   [错误] 打包 Python 运行时失败（PyInstaller）
echo  ====================================================
echo   没有产出 desktop\runtime\desktop_entry\desktop_entry.exe，
echo   这样打出来的安装包会缺瓦片服务，终端电脑上影像服务起不来。
echo   常见原因：磁盘空间不足（约需 1.5 GB）、杀毒软件拦截写入、
echo             .venv 依赖不全（先跑 scripts\一键配置环境.bat）。
echo   手动重试：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build_desktop_runtime.ps1 -Smoke
echo.
pause
exit /b 1


:build_fail
call "%~dp0_环境准备.bat" stop_heartbeat
rem 失败时把旧产物放回原位，避免用户丢掉上一次能用的包
call "%~dp0_环境准备.bat" unpark_stale "%FG_STALE_DIR%" "%FG_REL%\bundle\nsis" "*.exe"
call "%~dp0_环境准备.bat" unpark_stale "%FG_STALE_DIR%" "%FG_REL%\bundle\msi" "*.msi"
echo.
echo  ====================================================
echo   [错误] 构建安装包失败（npm run tauri:build）
echo  ====================================================
call "%~dp0_环境准备.bat" why_tauri
echo    · 报错含 "panicked at" 且提到 rust.rs 或 "missing manifest in toolchain"：
echo      说明 Rust 工具链损坏（安装被中断过），执行这条重装后重试：
echo          rustup toolchain install stable
echo    · NSIS / WiX 下载失败：安装包打包工具首次使用时需要联网下载，
echo      网络不通或需要代理时会失败。
echo    · 磁盘空间不足：构建会产生大量中间文件（建议留 10 GB）。
echo    · 路径含中文或空格：个别打包工具对非 ASCII 路径敏感，
echo      可尝试把项目复制到纯英文无空格目录（如 D:\fgd-build）再构建。
echo.
pause
exit /b 1


rem ====================================================================
rem  以下为内部子过程
rem ====================================================================

:show_artifacts
rem 打印三类产物（免安装 exe / NSIS 安装包 / MSI）。文件名含版本号，
rem 一律**按通配符查找**，绝不写死版本号（版本一升级就会误报「未找到」）。
echo  产物目录：
echo    %FG_REL%\
echo    %FG_REL%\bundle\
echo.

set "FG_ANY="
if exist "%FG_REL%\fgd-desktop.exe" set "FG_ANY=1"
for %%f in ("%FG_REL%\bundle\nsis\*.exe") do set "FG_ANY=1"
for %%f in ("%FG_REL%\bundle\msi\*.msi") do set "FG_ANY=1"
if not defined FG_ANY (
    echo  [提示] 本次构建未产出任何安装包（NSIS / MSI / 免安装 exe 均未找到）。
    echo  可能原因：本机未安装 NSIS / WiX 打包工具，或本次构建未成功。
    echo  正在把上一次的产物放回原位，避免你丢失旧文件……
    call "%~dp0_环境准备.bat" unpark_stale "%FG_STALE_DIR%" "%FG_REL%\bundle\nsis" "*.exe"
    call "%~dp0_环境准备.bat" unpark_stale "%FG_STALE_DIR%" "%FG_REL%\bundle\msi" "*.msi"
    set "FG_RESTORED=1"
    echo  已放回上一次的产物。为避免让你误装旧包，本次不会自动启动安装程序。
    exit /b 0
)

echo  免安装 exe（双击即用，无需安装）：
call :show_size "%FG_REL%\fgd-desktop.exe"
echo.
echo  NSIS 安装包（.exe 安装器）：
call :find_artifact "%FG_REL%\bundle\nsis\*.exe"
call :show_size "%FG_FOUND%"
echo.
echo  MSI 安装包（.msi）：
call :find_artifact "%FG_REL%\bundle\msi\*.msi"
call :show_size "%FG_FOUND%"
echo.
echo  提示：把上面任意一个安装包发给别人，对方双击即可安装
echo        （首次安装需联网，用于自动下载 WebView2 运行时）。
exit /b 0


:find_artifact
rem 参数：通配路径。取「修改时间最新」的一个写入 FG_FOUND（找不到则留空）。
rem ⚠️ 用 dir /b /o-d 取第一条，而不是 for %%f：目录里可能同时存在多个版本，
rem    for 会被字典序最后一个覆盖（"1.9.0" 排在 "1.10.0" 之后 → 选中旧包）。
set "FG_FOUND="
for /f "delims=" %%f in ('dir /b /o-d "%~1" 2^>nul') do if not defined FG_FOUND set "FG_FOUND=%~dp1%%f"
exit /b 0


:launch_installer
rem 构建成功后自动启动 NSIS 安装程序（只启 .exe，不同时启 MSI，否则装两遍）。
if defined FG_RESTORED (
    echo  [提示] 本次构建未产出安装包，不会启动任何安装程序。
    exit /b 0
)
call :find_artifact "%FG_REL%\bundle\nsis\*.exe"
if not defined FG_FOUND (
    echo.
    echo  ====================================================
    echo   [提示] 本次未产出 NSIS 安装包，不会启动安装程序
    echo  ====================================================
    echo   原因：本机可能未安装 NSIS 打包工具，或本次构建未包含该目标。
    echo   ⚠️ 为避免让你误装「上一次的旧包」，这里**不会**回退启动旧安装包。
    echo   可直接使用本次已生成的免安装 exe / MSI（见上方报告）。
    exit /b 0
)
echo.
echo  ====================================================
echo   即将启动安装程序，稍后会弹出安装界面…
echo  ====================================================
echo   安装程序：%FG_FOUND%
echo.
rem ⚠️ start 的第一个参数是窗口标题，必须留空 ""，否则含空格的路径会被当标题
start "" "%FG_FOUND%"
exit /b 0


:show_size
rem 参数：文件路径。存在则打印大小与路径；不存在如实提示「本次未产出」。
if "%~1"=="" (
    echo    （本次构建未产出该产物）
    exit /b 0
)
if not exist "%~1" (
    echo    （本次构建未产出该产物：%~1）
    exit /b 0
)
for %%A in ("%~1") do set "FG_BYTES=%%~zA"
set /a FG_MB=FG_BYTES/1048576
echo    大小：约 %FG_MB% MB
echo    路径：%~1
exit /b 0
