@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title Forest Gap Detection - 影像服务诊断

rem ============================================================
rem  影像服务起不来 —— 一键诊断（只读，不改任何设置）
rem
rem  背景：界面上的「影像服务没能启动」是个兜底提示，它只知道
rem  「120 秒内 /meta 没应答」，并不知道原因。真正的错误在
rem  瓦片服务自己的 stderr 里，而 release 版没有控制台，那些字
rem  全丢了。本脚本就是把它们重新捞出来。
rem
rem  用法：拷到公司电脑任意位置，双击。报告写到同目录
rem        「影像服务诊断报告.txt」，把它发回来即可。
rem ============================================================

set "OUT=%~dp0影像服务诊断报告.txt"
set "TMPD=%TEMP%\fgd-diag"
if not exist "%TMPD%" md "%TMPD%" >nul 2>nul
set "FGD_TMP=%TMPD%"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

> "%OUT%" echo Forest Gap Detection 影像服务诊断报告
>> "%OUT%" echo 时间: %DATE% %TIME%
>> "%OUT%" echo 计算机: %COMPUTERNAME%    用户: %USERNAME%
>> "%OUT%" echo.

call :say "================================================================"
call :say " Forest Gap Detection 影像服务诊断"
call :say " 只读检查，不修改任何设置"
call :say " 报告文件: %OUT%"
call :say "================================================================"

rem ==================== 1. 安装位置 ====================
call :say ""
call :say "【1】安装位置与运行时"
set "DE="
set "ROOT1=%LOCALAPPDATA%\Programs\Forest Gap Detection"
set "ROOT2=%ProgramFiles%\Forest Gap Detection"
set "ROOT3=%LOCALAPPDATA%\Forest Gap Detection"
if exist "%ROOT1%\py-runtime\desktop_entry\desktop_entry.exe" set "DE=%ROOT1%\py-runtime\desktop_entry\desktop_entry.exe"
if not defined DE if exist "%ROOT2%\py-runtime\desktop_entry\desktop_entry.exe" set "DE=%ROOT2%\py-runtime\desktop_entry\desktop_entry.exe"
if not defined DE if exist "%ROOT3%\py-runtime\desktop_entry\desktop_entry.exe" set "DE=%ROOT3%\py-runtime\desktop_entry\desktop_entry.exe"

if defined DE goto :got_de
call :say "  没在默认位置找到安装目录"
call :say "  请把安装目录粘进来，例如: D:\Forest Gap Detection"
set /p "MANUAL=  安装目录: "
if not defined MANUAL goto :de_missing
rem ⚠️ 清理粘贴带来的双引号与前导空格：资源管理器「复制为路径」会带 "..."，
rem    不清理的话下面的 exist 判定必然失败（2026-10-21 实测：路径明明存在，
rem    却报"该目录下没有 desktop_entry.exe"，还连带跳过了第 9/10 节的关键检查）。
set MANUAL=!MANUAL:"=!
for /f "tokens=* delims= " %%A in ("!MANUAL!") do set "MANUAL=%%A"
if exist "!MANUAL!\py-runtime\desktop_entry\desktop_entry.exe" set "DE=!MANUAL!\py-runtime\desktop_entry\desktop_entry.exe"
if defined DE goto :got_de
call :say "  [失败] 该目录下没有 py-runtime\desktop_entry\desktop_entry.exe"
goto :de_missing

:got_de
call :say "  desktop_entry.exe = !DE!"
for %%A in ("!DE!") do call :say "  大小 %%~zA 字节   时间 %%~tA"
set "MOTW="
for /f "delims=" %%Z in ('dir /r "!DE!" 2^>nul ^| findstr /i "Zone.Identifier"') do set "MOTW=1"
if defined MOTW call :say "  [警告] 带「来自网络」标记 —— 可能被 SmartScreen 或杀软静默拦截"
if not defined MOTW call :say "  没有「来自网络」标记"

:after_de
set "FGD_DE=%DE%"

rem ==================== 2. 配置里的影像路径 ====================
call :say ""
call :say "【2】软件记住的影像路径"
set "CFG=%LOCALAPPDATA%\fgd\settings.json"
set "FGD_CFG=%CFG%"
set "IMG="
del /q "%TMPD%\img.txt" >nul 2>nul
if not exist "%CFG%" goto :no_cfg
call :say "  settings.json 内容:"
type "%CFG%" >> "%OUT%"
type "%CFG%"
echo.
powershell -NoProfile -Command "try { $j = Get-Content -Raw -LiteralPath $env:FGD_CFG | ConvertFrom-Json; if ($j.image) { [IO.File]::WriteAllText((Join-Path $env:FGD_TMP 'img.txt'), [string]$j.image) } } catch { }" >nul 2>&1
if exist "%TMPD%\img.txt" set /p IMG=<"%TMPD%\img.txt"
goto :cfg_done

:no_cfg
call :say "  [提示] 没有 settings.json —— 影像路径从未成功保存过"

:cfg_done
set "FGD_SRC=%IMG%"

rem ==================== 3. 影像文件本身 ====================
call :say ""
call :say "【3】影像文件本身"
if not defined IMG goto :no_img
call :say "  路径: !IMG!"
if exist "!IMG!" goto :img_ok
call :say "  [严重] 这个文件现在不存在或无权访问 —— 很可能就是根因"
goto :img_done

:img_ok
for %%A in ("!IMG!") do call :say "  大小 %%~zA 字节   时间 %%~tA"
powershell -NoProfile -Command "try { $fs=[IO.File]::Open($env:FGD_SRC,'Open','Read','None'); $fs.Close(); Write-Output 'FILE_OK 可读且未被独占' } catch { Write-Output ('FILE_FAIL ' + $_.Exception.Message) }" > "%TMPD%\lock.txt" 2>&1
type "%TMPD%\lock.txt"
type "%TMPD%\lock.txt" >> "%OUT%"
goto :img_done

:no_img
call :say "  [提示] 配置里没有影像路径"

:img_done

rem ==================== 4. app.log ====================
call :say ""
call :say "【4】应用日志最后 40 行 —— 最关键的一节"
set "LOG=%LOCALAPPDATA%\fgd\logs\app.log"
set "FGD_LOG=%LOG%"
if not exist "%LOG%" goto :no_log
powershell -NoProfile -Command "Get-Content -LiteralPath $env:FGD_LOG -Tail 40 -Encoding UTF8" > "%TMPD%\log.txt" 2>&1
type "%TMPD%\log.txt"
type "%TMPD%\log.txt" >> "%OUT%"
goto :log_done

:no_log
call :say "  [严重] 没有 app.log —— 外壳程序可能根本没跑起来"

:log_done

rem ==================== 5. 端口 8765 ====================
call :say ""
call :say "【5】端口 8765 谁在监听"
netstat -ano | findstr /c:":8765 " > "%TMPD%\port.txt" 2>nul
for %%S in ("%TMPD%\port.txt") do if %%~zS==0 goto :port_free
call :say "  有连接记录:"
type "%TMPD%\port.txt"
type "%TMPD%\port.txt" >> "%OUT%"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /c:":8765 " ^| findstr /i "LISTENING"') do call :who %%P
goto :port_done

:port_free
call :say "  8765 上没有任何连接 —— 服务确实没起来"

:port_done

rem ==================== 6. 直接要 /meta ====================
call :say ""
call :say "【6】直接向 8765 要 /meta（绕开系统代理）"
powershell -NoProfile -Command "$wc=New-Object Net.WebClient; $wc.Proxy=$null; try{ $s=$wc.DownloadString('http://127.0.0.1:8765/meta'); if($s.Length -gt 400){ $s=$s.Substring(0,400) }; Write-Output ('META_OK ' + $s) } catch { Write-Output ('META_FAIL ' + $_.Exception.Message) }" > "%TMPD%\meta.txt" 2>&1
type "%TMPD%\meta.txt"
type "%TMPD%\meta.txt" >> "%OUT%"

rem ==================== 7. 系统代理 ====================
call :say ""
call :say "【7】系统代理设置（WebView2 会走它，可能拦住 127.0.0.1）"
netsh winhttp show proxy > "%TMPD%\px1.txt" 2>&1
type "%TMPD%\px1.txt"
type "%TMPD%\px1.txt" >> "%OUT%"
powershell -NoProfile -Command "$k='HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'; try { $p=Get-ItemProperty -Path $k -ErrorAction Stop; 'ProxyEnable = ' + $p.ProxyEnable; 'ProxyServer = ' + $p.ProxyServer; 'ProxyOverride = ' + $p.ProxyOverride } catch { 'REG_QUERY_FAIL ' + $_.Exception.Message }" > "%TMPD%\px2.txt" 2>&1
type "%TMPD%\px2.txt"
type "%TMPD%\px2.txt" >> "%OUT%"
call :say "  环境变量里的代理:"
set http_proxy >> "%OUT%" 2>&1
set https_proxy >> "%OUT%" 2>&1
set http_proxy
set https_proxy

rem ==================== 8. 杀毒软件 ====================
call :say ""
call :say "【8】安全软件（可能拦 PyInstaller 生成的 exe）"
powershell -NoProfile -Command "try { Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop | ForEach-Object { $_.displayName } } catch { 'QUERY_FAIL' }" > "%TMPD%\av.txt" 2>&1
type "%TMPD%\av.txt"
type "%TMPD%\av.txt" >> "%OUT%"

rem ==================== 9. 运行时自检 ====================
call :say ""
call :say "【9】打包运行时自检 --self-test"
if not defined DE goto :skip_selftest
"%DE%" --self-test > "%TMPD%\st.txt" 2>&1
set "RC=!ERRORLEVEL!"
call :say "  退出码 !RC!"
type "%TMPD%\st.txt"
type "%TMPD%\st.txt" >> "%OUT%"
goto :st_done

:skip_selftest
call :say "  [跳过] 没找到 desktop_entry.exe"

:st_done

rem ==================== 10. 直接起瓦片服务 ====================
call :say ""
call :say "【10】用你的影像直接起瓦片服务（端口 8799，12 秒后自动关）"
if not defined DE goto :skip_run
if not defined IMG goto :skip_run
del /q "%TMPD%\err.txt" >nul 2>nul
del /q "%TMPD%\out.txt" >nul 2>nul
powershell -NoProfile -Command "$q = [char]34; $psi = New-Object Diagnostics.ProcessStartInfo; $psi.FileName = $env:FGD_DE; $psi.Arguments = '--run-tile-server --source=' + $q + $env:FGD_SRC + $q + ' --port 8799'; $psi.UseShellExecute = $false; $psi.RedirectStandardError = $true; $psi.RedirectStandardOutput = $true; $psi.CreateNoWindow = $true; $p = [Diagnostics.Process]::Start($psi); $eo = $p.StandardError.ReadToEndAsync(); $oo = $p.StandardOutput.ReadToEndAsync(); Start-Sleep -Seconds 12; if ($p.HasExited) { Write-Output ('PROC_EXITED code=0x' + ('{0:X8}' -f $p.ExitCode)) } else { Write-Output 'PROC_STILL_RUNNING'; $wc = New-Object Net.WebClient; $wc.Proxy = $null; try { $m = $wc.DownloadString('http://127.0.0.1:8799/meta'); if ($m.Length -gt 200) { $m = $m.Substring(0,200) }; Write-Output ('PORT8799_META_OK ' + $m) } catch { Write-Output ('PORT8799_META_FAIL ' + $_.Exception.Message) }; try { $p.Kill() } catch { } }; Start-Sleep -Milliseconds 800; try { [IO.File]::WriteAllText((Join-Path $env:FGD_TMP 'err.txt'), $eo.Result) } catch { }; try { [IO.File]::WriteAllText((Join-Path $env:FGD_TMP 'out.txt'), $oo.Result) } catch { }" > "%TMPD%\run.txt" 2>&1
call :say "  进程结果:"
type "%TMPD%\run.txt"
type "%TMPD%\run.txt" >> "%OUT%"
call :say "  瓦片服务自己的输出（有 traceback 就在这里）:"
if not exist "%TMPD%\err.txt" goto :no_err
type "%TMPD%\err.txt"
type "%TMPD%\err.txt" >> "%OUT%"
goto :run_done

:no_err
call :say "  [空] 一个字都没有 —— 进程在打印之前就死了，指向 DLL 缺失或杀软拦截"

:run_done
goto :after_run

:skip_run
call :say "  [跳过] 缺少 exe 或影像路径"

:after_run

rem ==================== 11. 磁盘 ====================
call :say ""
call :say "【11】各磁盘剩余空间"
powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { '{0}  剩余 {1} GB / 共 {2} GB' -f $_.DeviceID, [math]::Round($_.FreeSpace/1GB,1), [math]::Round($_.Size/1GB,1) }" > "%TMPD%\disk.txt" 2>&1
type "%TMPD%\disk.txt"
type "%TMPD%\disk.txt" >> "%OUT%"

rem ==================== 结尾 ====================
call :say ""
call :say "================================================================"
call :say " 诊断完成"
call :say ""
call :say " 怎么读这份报告："
call :say "  · 第 10 节出现 PROC_EXITED 且 err.txt 为空 → DLL 缺失或被杀软拦截"
call :say "  · 第 10 节出现 PROC_EXITED 且 err.txt 有 traceback → 那个报错就是真因"
call :say "  · 第 10 节出现 PROC_STILL_RUNNING → 服务能起，问题在前端连不上"
call :say "    （看第 6 节：META_FAIL 说明连不上；第 7 节看代理）"
call :say "  · 第 5 节有 LISTENING 但不是本程序 → 端口被别的软件占了"
call :say "  · 第 4 节出现「复用现有服务」→ 同上，端口被占"
call :say ""
call :say " 报告文件: %OUT%"
call :say "================================================================"
echo.
pause
exit /b 0

rem ==================== 子过程 ====================
:say
if "%~1"=="" goto :say_blank
set "LINE=%~1"
echo !LINE!
>> "%OUT%" echo !LINE!
goto :eof

:say_blank
echo.
>> "%OUT%" echo.
goto :eof

:who
if "%~1"=="" goto :eof
powershell -NoProfile -Command "try { '  PID %~1 = ' + (Get-Process -Id %~1 -ErrorAction Stop).ProcessName } catch { '  PID %~1 = 已退出或无权查看' }" > "%TMPD%\who.txt" 2>&1
type "%TMPD%\who.txt"
type "%TMPD%\who.txt" >> "%OUT%"
goto :eof

rem 找不到 desktop_entry.exe 时的统一结论（第 1 节两个失败分支都跳到这）
:de_missing
call :say "  → 该路径下确实没有 py-runtime\desktop_entry\desktop_entry.exe。"
call :say "    排查顺序："
call :say "      1. 路径是否贴错（多一层同名目录？例如 D:\Forest Gap Detection\Forest Gap Detection）"
call :say "      2. 安装是否被中断 / 装到了别的盘（去「应用和功能」看实际位置）"
call :say "      3. 杀软是否隔离了 desktop_entry.exe（Windows 安全中心 → 保护历史记录）"
call :say "    确认目录后重跑本脚本，第 9/10 节才能给出真正的报错。"
goto :after_de
