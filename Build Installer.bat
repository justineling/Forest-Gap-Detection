@echo off
chcp 65001 >nul
title Forest Gap Detection - Build Installer
cd /d "%~dp0"
setlocal EnableExtensions
rem Ask the shared helper library (_环境准备.bat) to print English messages
set "FG_LANG=en"

echo.
echo  ====================================================
echo    Forest Gap Detection - Build Installer (for publishers)
echo    Intelligent gap detection in oil palm plantations
echo  ====================================================
echo.

rem ---- Self-healing: the project folder was moved -> drop the stale build cache ----
call "%~dp0_环境准备.bat" detect_move
if errorlevel 1 exit /b 1

rem Artifacts root: resolved by resolve_target_dir (fixed inside the project:
rem desktop\src-tauri\target unless FGD_USE_EXTERNAL_TARGET=1 is set)
call "%~dp0_环境准备.bat" resolve_target_dir
rem FG_REL / FG_STALE_DIR are finalized only after :prepare_build_env (see stage 4)

rem ============================================================
rem  Stage 1/4: check the build environment (Python venv / frontend deps / Rust)
rem  NOTE: WebView2 is NOT needed at build time - it is a runtime
rem        dependency for end users.
rem ============================================================
call "%~dp0_环境准备.bat" stage_begin 1 4 "Check build environment"
call "%~dp0_环境准备.bat" check_runtime
call "%~dp0_环境准备.bat" stage_end
if defined FG_NEED_PY goto :need_setup
if defined FG_NEED_NPM goto :need_setup
if defined FG_NEED_RUST goto :need_setup
goto :stage2_ready


:need_setup
call "%~dp0_环境准备.bat" stage_begin 2 4 "Install missing components"
echo.
echo   The environment is incomplete; launching the bundled one-click setup wizard (about 5-15 minutes).
echo.
call "%~dp0_环境准备.bat" start_heartbeat "Still configuring the environment" 40
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
call "%~dp0_环境准备.bat" stage_begin 2 4 "Install missing components"
echo   Environment complete, nothing to install.
call "%~dp0_环境准备.bat" stage_end
goto :stage3


:stage3
rem ============================================================
rem  Stage 3/4: build the frontend bundle (dist/)
rem ============================================================
call "%~dp0_环境准备.bat" stage_begin 3 4 "Build frontend bundle"
echo   Building the frontend (tsc type check + vite build, about 10-30 seconds)...
call "%~dp0_环境准备.bat" start_heartbeat "Still building the frontend" 10
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
rem  Stage 4/4: build the installer (tauri build)
rem ============================================================
call "%~dp0_环境准备.bat" stage_begin 4 4 "Build installer"
echo.
echo  ----------------------------------------------------
echo   Please note:
echo     1. The first build compiles the whole Rust shell; expect 10 to 20 minutes.
echo     2. When finished, the installer is written to the directory reported below.
echo     3. Building needs internet access (NSIS / WiX are downloaded on first use);
echo        WebView2 is downloaded by the installer at install time.
echo  ----------------------------------------------------
echo.


rem Neutralize CARGO_TARGET_DIR: installers always go to
rem   desktop\src-tauri\target\release\bundle\nsis\
call "%~dp0_环境准备.bat" prepare_build_env
set "FG_REL=%FG_TARGET%\release"
set "FG_STALE_DIR=%FG_REL%\bundle\_stale"
rem ---- Key: move the previous installers away (not delete, to _stale) ----
rem Purpose: after the build, the lookup can only hit THIS run's output.
rem        A zero-hit means "this run produced nothing" - it rules out
rem        the worst misreport: reporting / launching the previous package.
call "%~dp0_环境准备.bat" park_stale "%FG_REL%\bundle\nsis\*.exe" "%FG_STALE_DIR%"
call "%~dp0_环境准备.bat" park_stale "%FG_REL%\bundle\msi\*.msi" "%FG_STALE_DIR%"
call "%~dp0_环境准备.bat" mark_project_path
call "%~dp0_环境准备.bat" start_heartbeat "Still building (the linking stage can take a while)" 40
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
echo   Build complete
echo  ====================================================
echo.
call :show_artifacts
echo.
call :launch_installer
echo.
pause
exit /b 0


rem ====================================================================
rem  Error handling
rem ====================================================================

:setup_fail
call "%~dp0_环境准备.bat" stop_heartbeat
echo.
echo  ====================================================
echo   [ERROR] Environment setup did not complete
echo  ====================================================
call "%~dp0_环境准备.bat" why_python
pause
exit /b 1


:setup_still_missing
echo.
echo  ====================================================
echo   Components installed but still not detected
echo  ====================================================
echo   Fix: close this window and double-click "Build Installer.bat" again.
echo   (this session's PATH is still the snapshot from startup)
echo.
pause
exit /b 1


:npm_fail
call "%~dp0_环境准备.bat" stop_heartbeat
echo.
echo  ====================================================
echo   [ERROR] Frontend dependency install failed (npm install)
echo  ====================================================
echo   Fix: delete desktop\node_modules, then run this script again.
echo.
pause
exit /b 1


:build_front_fail
call "%~dp0_环境准备.bat" stop_heartbeat
echo.
echo  ====================================================
echo   [ERROR] Frontend build failed (npm run build)
echo  ====================================================
echo   Usually a TypeScript type error or a vite config issue; see the errors above.
echo   Quick local check: cd desktop ^&^& npx tsc --noEmit
echo.
pause
exit /b 1


:build_fail
call "%~dp0_环境准备.bat" stop_heartbeat
rem On failure, put the old artifacts back so the user does not lose the last working package
call "%~dp0_环境准备.bat" unpark_stale "%FG_STALE_DIR%" "%FG_REL%\bundle\nsis" "*.exe"
call "%~dp0_环境准备.bat" unpark_stale "%FG_STALE_DIR%" "%FG_REL%\bundle\msi" "*.msi"
echo.
echo  ====================================================
echo   [ERROR] Installer build failed (npm run tauri:build)
echo  ====================================================
call "%~dp0_环境准备.bat" why_tauri
echo    - NSIS / WiX download failed: the packaging tools are downloaded on first use;
echo      the build fails when the network is unreachable or a proxy is required.
echo    - Not enough disk space: the build produces many intermediate files (keep 10 GB free).
echo    - Path contains non-ASCII characters or spaces: some packaging tools are sensitive
echo      to non-ASCII paths. Try copying the project to a plain English directory
echo      without spaces (e.g. D:\fgd-build) and build there.
echo.
pause
exit /b 1


rem ====================================================================
rem  Internal subroutines
rem ====================================================================

:show_artifacts
rem Print the three artifact types (portable exe / NSIS installer / MSI).
rem File names contain the version number, so ALWAYS match by wildcard -
rem never hardcode the version (a version bump would cause a false "not found").
echo   Artifacts directory:
echo    %FG_REL%\
echo    %FG_REL%\bundle\
echo.

set "FG_ANY="
if exist "%FG_REL%\fgd-desktop.exe" set "FG_ANY=1"
for %%f in ("%FG_REL%\bundle\nsis\*.exe") do set "FG_ANY=1"
for %%f in ("%FG_REL%\bundle\msi\*.msi") do set "FG_ANY=1"
if not defined FG_ANY (
    echo  [NOTE] This build produced no installer - no NSIS / MSI / portable exe found.
    echo  Possible cause: NSIS / WiX packaging tools are not installed on this machine, or this build did not succeed.
    echo  Restoring the previous artifacts so you do not lose old files...
    call "%~dp0_环境准备.bat" unpark_stale "%FG_STALE_DIR%" "%FG_REL%\bundle\nsis" "*.exe"
    call "%~dp0_环境准备.bat" unpark_stale "%FG_STALE_DIR%" "%FG_REL%\bundle\msi" "*.msi"
    set "FG_RESTORED=1"
    echo  The previous artifacts are restored. To avoid installing a stale package by
    echo  mistake, no installer will be launched this time.
    exit /b 0
)

echo  Portable exe (double-click to run, no install needed):
call :show_size "%FG_REL%\fgd-desktop.exe"
echo.
echo  NSIS installer (.exe setup):
call :find_artifact "%FG_REL%\bundle\nsis\*.exe"
call :show_size "%FG_FOUND%"
echo.
echo  MSI installer (.msi):
call :find_artifact "%FG_REL%\bundle\msi\*.msi"
call :show_size "%FG_FOUND%"
echo.
echo  Tip: send any installer above to others; they can install it by double-clicking
echo       (the first install needs internet to download the WebView2 runtime).
exit /b 0


:find_artifact
rem Arg: wildcard path. Picks the most recently modified match into FG_FOUND
rem (empty if none). WARNING: uses "dir /b /o-d" and takes the first line,
rem not "for %%f": the directory may hold several versions at once, and
rem "for" is overwritten by the dictionary-order last one
rem ("1.9.0" sorts after "1.10.0" -> would pick the old package).
set "FG_FOUND="
for /f "delims=" %%f in ('dir /b /o-d "%~1" 2^>nul') do if not defined FG_FOUND set "FG_FOUND=%~dp1%%f"
exit /b 0


:launch_installer
rem Auto-start the NSIS installer after a successful build (.exe only, never
rem the MSI at the same time, otherwise it installs twice).
if defined FG_RESTORED (
    echo  [NOTE] This build produced no installer; no installer will be launched.
    exit /b 0
)
call :find_artifact "%FG_REL%\bundle\nsis\*.exe"
if not defined FG_FOUND (
    echo.
    echo  ====================================================
    echo   [NOTE] No NSIS installer was produced this time; no installer will be launched
    echo  ====================================================
    echo   Reason: NSIS packaging tools may not be installed, or this build did not include that target.
    echo   WARNING: to avoid installing the previous stale package by mistake, this script
    echo   does NOT fall back to launching the old installer.
    echo   You can use the portable exe / MSI produced this time instead - see the report above.
    exit /b 0
)
echo.
echo  ====================================================
echo   Launching the installer; the setup window will appear shortly...
echo  ====================================================
echo   Installer: %FG_FOUND%
echo.
rem WARNING: the first argument of "start" is the window title and must stay
rem empty "" - otherwise a path containing spaces is treated as the title.
start "" "%FG_FOUND%"
exit /b 0


:show_size
rem Arg: file path. Prints the size and path when it exists; otherwise
rem honestly reports "not produced this time".
if "%~1"=="" (
    echo    - not produced by this build -
    exit /b 0
)
if not exist "%~1" (
    echo    - not produced by this build: %~1 -
    exit /b 0
)
for %%A in ("%~1") do set "FG_BYTES=%%~zA"
set /a FG_MB=FG_BYTES/1048576
echo    Size: about %FG_MB% MB
echo    Path: %~1
exit /b 0
