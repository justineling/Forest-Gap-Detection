@echo off
chcp 65001 >nul
rem ============================================================================
rem  Forest Gap Detection - 共享环境工具（被「启动桌面端.bat」「构建安装包.bat」调用）
rem  ⚠️ 本文件与两个入口脚本都放在**项目根目录**，前端工程在 desktop\ 下。
rem
rem  用法：call "%~dp0_环境准备.bat" <函数名> [参数...]
rem  ⚠️ 本文件**不要直接双击运行**（无主流程，会直接退出）。
rem
rem  ⚠️ 派发机制（关键，别改）：`call 文件.bat 标签 参数` 在 cmd 里**不是**
rem     "跳到文件内的标签"，而是把"标签"当成 %1 传给文件、文件**从头执行**。
rem     所以必须在顶部自己 shift 掉函数名再 goto，子过程里的 %1..%9 才是
rem     调用方真正传进来的参数。
rem  ⚠️ 顶层**不能** setlocal：setlocal 会让所有 set 都留在局部作用域，
rem     call 返回后调用方拿不到 FG_NEED_* / FG_DEV_PORT 这些结果变量。
rem
rem  设计原则（与同作者的 KIRA Manager 脚本保持一致）：
rem    · 长任务用心跳，避免用户以为卡死
rem    · 端口被占自动换一个，而不是直接失败
rem    · 旧产物先挪走再构建，杜绝"报告/弹出上一次的旧包"
rem    · 环境缺什么自动装什么，装不上给可操作的中文原因
rem ============================================================================
set "FG_LIB_ENTRY=%~1"
if not defined FG_LIB_ENTRY exit /b 0
shift
goto %FG_LIB_ENTRY%


rem ============================================================================
rem  阶段提示（带进度条）
rem ============================================================================
:stage_begin
rem 参数：%1=当前阶段 %2=总阶段数 %3=阶段名称
set "FG_STAGE_CUR=%~1"
set "FG_STAGE_ALL=%~2"
set "FG_STAGE_NAME=%~3"
echo.
echo  ------------------------------------------------------------
echo   [%FG_STAGE_CUR%/%FG_STAGE_ALL%] %FG_STAGE_NAME%
echo  ------------------------------------------------------------
exit /b 0


:stage_end
if "%FG_LANG%"=="en" (
    echo   [done] %FG_STAGE_NAME%
) else (
    echo   [完成] %FG_STAGE_NAME%
)
exit /b 0


rem ============================================================================
rem  长任务心跳
rem  ---------------------------------------------------------------------------
rem  npm install / tauri build / cargo 编译可能数分钟毫无输出（Rust 链接阶段
rem  尤其如此），用户会误以为卡死。心跳在后台每 ~10 秒打印一行。
rem
rem  ⚠️ 三条硬约束：
rem    1. 心跳是**独立进程**（start /b），主流程的长命令仍前台直跑 ——
rem       绝不用管道跑长命令（cmd 里 `A | B` 之后 %ERRORLEVEL% 是 B 的，
rem       会让失败被误判为成功）。
rem    2. 停止靠**哨兵文件**，绝不用 taskkill（会误杀用户其它 cmd 窗口）。
rem    3. 心跳**自限时**（默认 90 分钟），主脚本异常退出也不会留永久孤儿。
rem ============================================================================
:start_heartbeat
rem 参数：%1=文案（可选） %2=最长运行分钟数（可选，默认 90）
set "FG_HB_MSG=%~1"
if not defined FG_HB_MSG (
    if "%FG_LANG%"=="en" (
        set "FG_HB_MSG=Still working, please wait..."
    ) else (
        set "FG_HB_MSG=仍在处理，请耐心等待"
    )
)
set "FG_HB_MAXMIN=%~2"
if not defined FG_HB_MAXMIN set "FG_HB_MAXMIN=90"
set "FG_HB_SENT=%TEMP%\fgd-hb-%RANDOM%-%RANDOM%.flag"
if exist "%FG_HB_SENT%" del /q "%FG_HB_SENT%" >nul 2>nul
start "" /b cmd /c ""%~dp0_环境准备.bat" hb_loop "%FG_HB_SENT%" "%FG_HB_MSG%" %FG_HB_MAXMIN%
exit /b 0


:stop_heartbeat
rem 创建哨兵文件 → 后台心跳 ≤10 秒内自行退出。幂等：未起过则为空操作。
if not defined FG_HB_SENT exit /b 0
if not exist "%FG_HB_SENT%" type nul > "%FG_HB_SENT%"
exit /b 0


:hb_loop
rem 后台心跳循环。参数：%1=哨兵 %2=文案 %3=最长分钟数
set "FG_HB_SENT=%~1"
set "FG_HB_MSG=%~2"
set "FG_HB_MAXMIN=%~3"
if not defined FG_HB_MAXMIN set "FG_HB_MAXMIN=90"
set /a FG_HB_MAXTICKS=FG_HB_MAXMIN*6
if %FG_HB_MAXTICKS% lss 1 set /a FG_HB_MAXTICKS=1
set /a FG_HB_TICKS=0
call :now_epoch
set "FG_HB_T0=%FG_EPOCH%"
:hb_tick
rem 用 ping 作睡眠（timeout 需要控制台，不适合后台进程）
ping -n 11 127.0.0.1 >nul
if exist "%FG_HB_SENT%" goto :hb_done
set /a FG_HB_TICKS=FG_HB_TICKS+1
call :now_epoch
if not defined FG_EPOCH goto :hb_ticks_only
if not defined FG_HB_T0 goto :hb_ticks_only
set /a FG_HB_DT=FG_EPOCH-FG_HB_T0
if %FG_HB_DT% lss 0 set "FG_HB_DT=0"
set /a FG_HB_M=FG_HB_DT/60
set /a FG_HB_S=FG_HB_DT-FG_HB_M*60
if "%FG_LANG%"=="en" (
    echo   ... %FG_HB_MSG% - elapsed %FG_HB_M% min %FG_HB_S% sec
) else (
    echo   ... %FG_HB_MSG%（已用 %FG_HB_M% 分 %FG_HB_S% 秒）
)
set /a FG_HB_LIMIT=FG_HB_MAXMIN*60
if %FG_HB_DT% geq %FG_HB_LIMIT% goto :hb_done
if %FG_HB_TICKS% geq %FG_HB_MAXTICKS% goto :hb_done
goto :hb_tick

:hb_ticks_only
set /a FG_HB_M=FG_HB_TICKS/6
set /a FG_HB_S=FG_HB_TICKS*10-FG_HB_M*60
if "%FG_LANG%"=="en" (
    echo   ... %FG_HB_MSG% - about %FG_HB_M% min %FG_HB_S% sec
) else (
    echo   ... %FG_HB_MSG%（已约 %FG_HB_M% 分 %FG_HB_S% 秒）
)
if %FG_HB_TICKS% geq %FG_HB_MAXTICKS% goto :hb_done
goto :hb_tick

:hb_done
if exist "%FG_HB_SENT%" del /q "%FG_HB_SENT%" >nul 2>nul
exit /b 0


:now_epoch
set "FG_EPOCH="
for /f "delims=" %%s in ('powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()" 2^>nul') do set "FG_EPOCH=%%s"
exit /b 0


rem ============================================================================
rem  端口工具
rem  ---------------------------------------------------------------------------
rem  两个端口都会撞车：
rem    · 5173 前端 dev（vite strictPort=true 会**直接失败**）
rem    · 8765 瓦片服务（被上次没退干净的 python 占住时，会静默复用**旧版本**服务）
rem  所以一律"先探测再决定"：占用了就换下一个，而不是硬失败。
rem ============================================================================
:port_free
rem 参数：%1=端口。空闲 exit /b 0，被占 exit /b 1。
rem ⚠️ findstr 的匹配串带上尾部空格：否则 :5173 会误匹配 :51730
netstat -ano 2>nul | findstr /r /c:"LISTENING" | findstr /c:":%~1 " >nul 2>nul
if errorlevel 1 exit /b 0
exit /b 1


:pick_port
rem 参数：%1=起始端口 %2=尝试个数 %3=输出变量名（找到则赋值，找不到留空）
set /a FG_P=%1
set /a FG_PEND=%~1+%~2
:pp_loop
call :port_free %FG_P%
if not errorlevel 1 (
    set "%~3=%FG_P%"
    exit /b 0
)
set /a FG_P+=1
if %FG_P% lss %FG_PEND% goto :pp_loop
set "%~3="
exit /b 1


:kill_port_owner
rem 参数：%1=端口。仅用于**本项目自己的**残留进程：打印 PID 并询问式提示，不自动杀。
rem 自动 taskkill 风险太大（可能杀掉用户别的服务），这里只给操作指引。
echo   端口 %~1 已被占用，占用进程 PID：
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr /r /c:"LISTENING" ^| findstr /c:":%~1 "') do echo     PID %%p
echo   如需释放：任务管理器结束该 PID，或执行  taskkill /PID <PID> /F
exit /b 0


rem ============================================================================
rem  前置条件检测
rem ============================================================================
:check_runtime
rem 检测三项运行时前置：.venv（Python）、node_modules、cargo。
rem 缺失的置 FG_NEED_* 标志并逐项打印。
set "FG_NEED_PY="
set "FG_NEED_NPM="
set "FG_NEED_RUST="

if exist "%~dp0.venv\Scripts\python.exe" (
    if "%FG_LANG%"=="en" (echo   [ready]   Python virtual environment .venv) else (echo   [已就绪] Python 虚拟环境 .venv)
) else (
    set "FG_NEED_PY=1"
    if "%FG_LANG%"=="en" (echo   [missing] Python virtual environment .venv) else (echo   [缺失]   Python 虚拟环境 .venv)
)

if exist "%~dp0desktop\node_modules" (
    if "%FG_LANG%"=="en" (echo   [ready]   Frontend dependencies node_modules) else (echo   [已就绪] 前端依赖 node_modules)
) else (
    set "FG_NEED_NPM=1"
    if "%FG_LANG%"=="en" (echo   [missing] Frontend dependencies node_modules) else (echo   [缺失]   前端依赖 node_modules)
)

where cargo >nul 2>nul
if errorlevel 1 goto :cr_rust_missing
rem ⚠️ 只 where 到 cargo 不够：rustup 装了但没有默认工具链时，cargo 是个
rem    shim，能 where 到、一执行就报 "rustup could not choose a version of
rem    cargo to run ... no default is configured"（公司电脑实测踩过）。
rem    必须真跑一次 --version 才算就绪，否则会被误判为"环境完整"、
rem    跳过自动安装，然后在 tauri build 阶段才失败。
cargo --version >nul 2>nul
if errorlevel 1 goto :cr_rust_missing
if "%FG_LANG%"=="en" (echo   [ready]   Rust toolchain) else (echo   [已就绪] Rust 工具链)
goto :cr_rust_done

:cr_rust_missing
set "FG_NEED_RUST=1"
if "%FG_LANG%"=="en" (echo   [missing] Rust toolchain - cargo exists but cannot run) else (echo   [缺失]   Rust 工具链（cargo 不可用或无默认工具链）)

:cr_rust_done
exit /b 0


:ensure_python_env
rem 调用项目已有的环境配置向导（scripts\一键配置环境.bat → 配置环境.ps1）。
rem 那个脚本会做 6 个阶段：系统检测 / 工具链 / GPU / 安装 / venv+依赖 / 模型+前端依赖。
if not exist "%~dp0scripts\一键配置环境.bat" (
    if "%FG_LANG%"=="en" (echo   [ERROR] The bundled setup wizard was not found; cannot configure the environment automatically.) else (echo   [错误] 找不到 scripts\一键配置环境.bat，无法自动配置环境。)
    exit /b 1
)
if "%FG_LANG%"=="en" (
    echo   Launching the bundled setup wizard - first run takes about 5-15 minutes...
    echo   - it installs the Python environment, dependencies and the Rust toolchain, printing progress all the way
) else (
    echo   正在调用项目自带的环境配置向导（首次约 5~15 分钟）...
    echo   （它会把 Python 环境、依赖、Rust 工具链都装好；期间会持续输出进度）
)
call "%~dp0scripts\一键配置环境.bat"
if errorlevel 1 exit /b 1
exit /b 0


:ensure_npm
if exist "%~dp0desktop\node_modules" exit /b 0
if "%FG_LANG%"=="en" (
    echo   Downloading frontend dependencies - first run takes about 1-3 minutes...
    call :start_heartbeat "Still downloading frontend dependencies" 30
) else (
    echo   正在下载前端依赖（首次约 1~3 分钟）...
    call :start_heartbeat "仍在下载前端依赖" 30
)
pushd "%~dp0desktop"
call npm install
set "FG_RC=%ERRORLEVEL%"
popd
call :stop_heartbeat
if not "%FG_RC%"=="0" exit /b 1
exit /b 0


rem ============================================================================
rem  构建产物路径（尊重 CARGO_TARGET_DIR）
rem  ---------------------------------------------------------------------------
rem  本机把 CARGO_TARGET_DIR 指到了 D:\forest-gap-tools\rust\target（省 C 盘）。
rem  写死 src-tauri\target 会让「构建安装包.bat」找不到产物，所以统一走这个函数。
rem ============================================================================
:resolve_target_dir
rem 编译产物**固定在项目内**（`desktop\src-tauri\target`），与其他项目保持一致。
rem 不再跟随 CARGO_TARGET_DIR —— 那是个用户级环境变量，会把产物甩到项目外
rem （本机曾指到 D:\forest-gap-tools\rust\target），卸载/清理/交付都很别扭。
rem 想临时改回来：给脚本设 FGD_USE_EXTERNAL_TARGET=1 即可（排障用）。
rem ⚠️ 先给默认值再按需覆盖：`if A if B (X) else (Y)` 在 A 为假时会**整条跳过**，
rem    包括 else 分支 —— 那样 FG_TARGET 会变成空（实测踩过）。
set "FG_TARGET=%~dp0desktop\src-tauri\target"
if defined FGD_USE_EXTERNAL_TARGET if defined CARGO_TARGET_DIR set "FG_TARGET=%CARGO_TARGET_DIR%"
exit /b 0


:prepare_build_env
rem 在跑 npm/cargo 之前调一次：**中和**当前进程的 CARGO_TARGET_DIR，
rem 让 cargo 回落到默认的 `desktop\src-tauri\target`。
rem ⚠️ 只改本进程的环境变量，**绝不** setx / 改注册表 —— 不影响用户其它项目。
if defined CARGO_TARGET_DIR (
    if "%FG_LANG%"=="en" (
        echo   [NOTE] Temporarily ignoring CARGO_TARGET_DIR %CARGO_TARGET_DIR%;
        echo         artifacts are fixed inside the project: desktop\src-tauri\target
        echo         - switching once rebuilds everything, about 5-10 minutes; later runs use the cache
    ) else (
        echo   [提示] 已临时忽略 CARGO_TARGET_DIR（%CARGO_TARGET_DIR%），
        echo          编译产物固定到项目内：desktop\src-tauri\target
        echo          （首次切换会重新编译一遍，约 5~10 分钟，之后就有缓存）
    )
)
set "CARGO_TARGET_DIR="
set "FG_TARGET=%~dp0desktop\src-tauri\target"
exit /b 0


rem ============================================================================
rem  旧产物归档（构建前挪走 → 构建后只可能命中本次产物）
rem ============================================================================
:park_stale
rem 参数：%1=通配路径 %2=停放目录。存在则逐个移到停放目录（不删除）。
if not exist "%~2" mkdir "%~2" >nul 2>nul
for %%f in ("%~1") do (
    if exist "%%~ff" (
        move /y "%%~ff" "%~2\" >nul 2>nul
    )
)
exit /b 0


:unpark_stale
rem 参数：%1=停放目录 %2=目标目录 %3=通配。把上次停放的产物放回原位。
if not exist "%~1" exit /b 0
if not exist "%~2" mkdir "%~2" >nul 2>nul
for %%f in ("%~1\*%~3") do (
    if exist "%%~ff" move /y "%%~ff" "%~2\" >nul 2>nul
)
exit /b 0


rem ============================================================================
rem  项目搬家检测（编译缓存里记的是绝对路径，搬家后必须清）
rem ============================================================================
:detect_move
call :resolve_target_dir
if not exist "%FG_TARGET%" exit /b 0

rem ⚠️ **只对项目内的 target 做搬家检测**。
rem    本机把 CARGO_TARGET_DIR 指到了 D://forest-gap-tools//rust//target/uff08/u7701 C 盘），
rem    那是**多个项目可能共用**的外部目录：里面没有本项目的路径标记，
rem    .d 文件记录的也是别的项目路径 → 会被误判成"搬家"然后 rmdir 清空，
rem    直接把别人的编译缓存删掉。这种破坏性误判必须从源头掐掉。
set "FG_LOCAL_TARGET=%~dp0desktop\src-tauri\target"
if /i not "%FG_TARGET%"=="%FG_LOCAL_TARGET%" (
    if "%FG_LANG%"=="en" (echo   [NOTE] CARGO_TARGET_DIR points outside the project %FG_TARGET%; skipping the move check.) else (echo   [提示] CARGO_TARGET_DIR 指向项目外（%FG_TARGET%），跳过搬家检测。)
    exit /b 0
)

set "FG_MOVED="
if not exist "%FG_TARGET%\.fgd-project-path" goto :dm_scan
set "FG_MARK="
set /p FG_MARK=<"%FG_TARGET%\.fgd-project-path"
if /i not "%FG_MARK%"=="%CD%" set "FG_MOVED=1"
if defined FG_MOVED goto :dm_hit
exit /b 0

:dm_scan
rem 老缓存没有标记文件时，用 .d 文件里记录的绝对路径兜底。
rem ⚠️ .d 文件把源码路径里的空格转义成了 "\ "，比较前也要同样转义。
set "FG_ESC=%CD: =\ %"
for %%d in ("%FG_TARGET%\debug\*.d") do call :dm_check "%%~fd"
if defined FG_MOVED goto :dm_hit
exit /b 0

:dm_check
"%SystemRoot%\System32\find.exe" /i "%FG_ESC%" %1 >nul 2>nul
if errorlevel 1 set "FG_MOVED=1"
exit /b 0

:dm_hit
echo.
echo  ====================================================
if "%FG_LANG%"=="en" (
    echo   The project folder has been moved
) else (
    echo   检测到项目文件夹被移动过
)
echo  ====================================================
if "%FG_LANG%"=="en" (
    echo  The previous build cache points to the old location and is stale;
    echo  it must be cleaned before rebuilding.
    echo  Cleaning now - may take a few minutes; do not close this window...
    call :start_heartbeat "Still cleaning the stale build cache" 20
) else (
    echo  之前的编译缓存指向旧位置，已失效，需要清理后重新编译。
    echo  正在清理（可能要几分钟，期间请勿关闭窗口）...
    call :start_heartbeat "仍在清理失效的编译缓存" 20
)
if exist "%FG_TARGET%" rmdir /s /q "%FG_TARGET%"
call :stop_heartbeat
if exist "%FG_TARGET%" (
    echo.
    if "%FG_LANG%"=="en" (
        echo  [ERROR] Cleanup failed - usually the folder is in use
        echo  - an open app window / File Explorer / antivirus software.
        echo  Close them and double-click this file again.
    ) else (
        echo  [错误] 清理失败 —— 通常是该文件夹正被占用
        echo  （已开着的应用窗口 / 资源管理器 / 杀毒软件）。
        echo  请关掉它们后重新双击本文件。
    )
    exit /b 1
)
if "%FG_LANG%"=="en" (echo  Cleanup done, continuing.) else (echo  清理完成，继续。)
exit /b 0


:mark_project_path
call :resolve_target_dir
rem 只在项目内 target 时写标记（外部共享目录不写，避免污染别的项目）
set "FG_LOCAL_TARGET=%~dp0desktop\src-tauri\target"
if /i not "%FG_TARGET%"=="%FG_LOCAL_TARGET%" exit /b 0
if not exist "%FG_TARGET%" mkdir "%FG_TARGET%" >nul 2>nul
cd > "%FG_TARGET%\.fgd-project-path"
exit /b 0


rem ============================================================================
rem  原因说明（错误分支统一调用，避免每个脚本各写一份）
rem ============================================================================
:why_tauri
echo.
if "%FG_LANG%"=="en" (
    echo  Possible causes and fixes:
    echo    - MSVC build tools missing: if the error mentions link.exe not found or
    echo      LINK : fatal error, the C++ toolchain is not installed. Re-run the
    echo      project one-click setup to install it automatically, or install
    echo      "Visual Studio 2022 Build Tools" with the "Desktop development with C++" workload.
    echo    - WebView2 runtime missing: re-run the project one-click setup to install it.
    echo    - Port in use: the script picks another port automatically; if it still fails,
    echo      see the port-in-use notice above.
    echo    - Antivirus blocking: add this folder to the trust list and retry.
    echo    - First compile is slow: 10-20 minutes on the first run is normal.
    echo.
) else (
    echo  可能的原因与对应处理：
    echo    · 缺少 MSVC 生成工具：若报错含 link.exe not found 或 LINK : fatal error，
    echo      说明 C++ 编译工具没装好。请重新运行「启动桌面端.bat」自动安装，
    echo      或手动安装「Visual Studio 2022 生成工具」并勾选「使用 C++ 的桌面开发」。
    echo    · 缺少 WebView2 运行时：重新运行「启动桌面端.bat」自动安装。
    echo    · 端口被占用：脚本会自动换端口；若仍失败，见上方端口占用提示。
    echo    · 杀毒软件拦截：把本文件夹加入信任后重试。
    echo    · 首次编译较慢：首次约 10~20 分钟属正常。
    echo.
)
exit /b 0


:why_python
echo.
if "%FG_LANG%"=="en" (
    echo  Possible causes and fixes:
    echo    - Python 3.11+ not installed: install it from python.org and tick "Add to PATH".
    echo    - .venv creation failed: make sure at least 5 GB of disk space is free.
    echo    - Dependency download failed: check access to pypi or configure a mirror.
    echo    - If it keeps failing, send a screenshot of the errors in this window.
    echo.
) else (
    echo  可能的原因与对应处理：
    echo    · Python 3.11+ 未安装：请到 python.org 安装并勾选「Add to PATH」。
    echo    · .venv 创建失败：确认磁盘剩余空间 ≥ 5 GB。
    echo    · 依赖下载失败：确认能访问 pypi（或配置国内镜像）。
    echo    · 若反复失败，请把本窗口的报错内容截图反馈。
    echo.
)
exit /b 0
