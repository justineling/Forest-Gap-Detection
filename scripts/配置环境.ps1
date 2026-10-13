<#
================================================================================
 Forest Gap Detection — 一键环境配置脚本（低权限友好 · 全量装到 D 盘）
================================================================================
 设计目标：
   1. 尽量「零管理员权限」完成环境配置（用户级安装）
   2. 所有大体积产物（venv / pip 缓存 / Rust 工具链 / 模型 / 编译产物）全部放 D 盘，
      避免撑爆系统盘（实测本机 C 盘仅剩 26 GB，D 盘剩 95 GB）
   3. 人性化：彩色进度、长任务每 20 秒报「仍在正常运行」、下载带实时进度条
   4. 能自动装的自动装；装不了的结尾列出下载地址让用户手动装
   5. 结尾输出「环境检测报告」（控制台表格 + Markdown 文件）
   6. 幂等：已装好的自动跳过，可反复运行

 用法（推荐直接双击「一键配置环境.bat」）：
   powershell -ExecutionPolicy Bypass -File scripts\配置环境.ps1
   powershell -ExecutionPolicy Bypass -File scripts\配置环境.ps1 -CheckOnly
   powershell -ExecutionPolicy Bypass -File scripts\配置环境.ps1 -UseChinaMirror

 参数：
   -CheckOnly        只检测并出报告，不做任何安装（安全）
   -DataDrive        存放工具链的盘符，默认自动选择剩余空间最大的非系统盘（如 D）
   -InstallRoot      工具安装目录，默认 <DataDrive>:\forest-gap-tools
   -SkipAI           跳过 PyTorch 等大体积 AI 运行时
   -SkipModels       跳过模型权重下载
   -SkipNode         跳过前端 Node.js 环境
   -SkipRust         跳过 Rust 工具链
   -UseChinaMirror   使用国内镜像源（pip / npm / rustup）
   -HeartbeatSeconds 长任务心跳间隔秒数，默认 20
================================================================================
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$SkipAI,
    [switch]$SkipModels,
    [switch]$SkipNode,
    [switch]$SkipRust,
    [switch]$UseChinaMirror,
    [string]$DataDrive = '',
    [string]$InstallRoot = '',
    [string]$ReportPath = '',
    [int]$HeartbeatSeconds = 20
)

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'
$script:StartTime      = Get-Date
$script:HeartbeatSec   = $HeartbeatSeconds
$script:Results        = New-Object System.Collections.ArrayList
$script:ManualList     = New-Object System.Collections.ArrayList
$script:Warnings       = New-Object System.Collections.ArrayList

# ============================ 输出辅助 ============================
function Say   { param([string]$m,[string]$c='Gray') Write-Host $m -ForegroundColor $c }
function Title { param([string]$m)
    Write-Host ''
    Write-Host ('─' * 76) -ForegroundColor DarkCyan
    Write-Host "  $m" -ForegroundColor Cyan
    Write-Host ('─' * 76) -ForegroundColor DarkCyan }
function Ok    { param([string]$m) Write-Host "  [ OK ] $m"   -ForegroundColor Green }
function Warn  { param([string]$m) Write-Host "  [警告] $m"   -ForegroundColor Yellow; [void]$script:Warnings.Add($m) }
function Fail  { param([string]$m) Write-Host "  [缺失] $m"   -ForegroundColor Red }
function Info  { param([string]$m) Write-Host "  [信息] $m"   -ForegroundColor DarkGray }
function Act   { param([string]$m) Write-Host "  [执行] $m"   -ForegroundColor Magenta }
function Beat  { param([string]$m) Write-Host "         · $m" -ForegroundColor DarkGray }

function Add-Result {
    param([string]$Name,[string]$Status,[string]$Detail,[string]$Required='必需')
    [void]$script:Results.Add([pscustomobject]@{ Component=$Name; Status=$Status; Detail=$Detail; Required=$Required })
}
function Add-Manual {
    param([string]$Name,[string]$Url,[string]$Why)
    [void]$script:ManualList.Add([pscustomobject]@{ Component=$Name; Url=$Url; Why=$Why })
}

# ============================ 0. 盘符与目录决策 ============================
function Get-BestDataDrive {
    # 选择剩余空间最大的「非系统盘」；若都不如系统盘则回退系统盘
    $sys = $env:SystemDrive.TrimEnd(':')
    $cands = @()
    foreach ($d in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
        if (-not $d.Free) { continue }
        if ($d.Name.Length -ne 1) { continue }
        $cands += [pscustomobject]@{ Letter = $d.Name; Free = $d.Free; IsSystem = ($d.Name -eq $sys) }
    }
    if ($cands.Count -eq 0) { return $sys }
    $nonSys = $cands | Where-Object { -not $_.IsSystem } | Sort-Object Free -Descending
    if ($nonSys -and $nonSys[0].Free -gt 5GB) { return $nonSys[0].Letter }
    return ($cands | Sort-Object Free -Descending)[0].Letter
}

if ([string]::IsNullOrWhiteSpace($DataDrive)) { $DataDrive = Get-BestDataDrive }
$DataDrive = $DataDrive.TrimEnd(':')
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = "${DataDrive}:\forest-gap-tools" }
if ([string]::IsNullOrWhiteSpace($ReportPath)) {
    $projRootGuess = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).Path }
    $ReportPath = Join-Path $projRootGuess 'docs\environment-report.md'
}
$script:LogFile = Join-Path $InstallRoot 'logs\setup-env.log'

$dirs = @{
    Root      = $InstallRoot
    PipCache  = Join-Path $InstallRoot 'pip-cache'
    NpmCache  = Join-Path $InstallRoot 'npm-cache'
    RustupHome= Join-Path $InstallRoot 'rust\rustup'
    CargoHome = Join-Path $InstallRoot 'rust\cargo'
    CargoTarget= Join-Path $InstallRoot 'rust\target'
    Downloads = Join-Path $InstallRoot 'downloads'
    Logs      = Join-Path $InstallRoot 'logs'
    HfCache   = Join-Path $InstallRoot 'hf-cache'
    TorchCache= Join-Path $InstallRoot 'torch-cache'
}
foreach ($k in $dirs.Keys) {
    if (-not (Test-Path $dirs[$k])) { New-Item -ItemType Directory -Path $dirs[$k] -Force | Out-Null }
}

# 把大体积产物全部指向 D 盘（进程级 + 用户级持久化）
$env:PIP_CACHE_DIR     = $dirs.PipCache
$env:CARGO_HOME        = $dirs.CargoHome
$env:RUSTUP_HOME       = $dirs.RustupHome
$env:CARGO_TARGET_DIR  = $dirs.CargoTarget
$env:npm_config_cache  = $dirs.NpmCache
$env:HF_HOME           = $dirs.HfCache
$env:TORCH_HOME        = $dirs.TorchCache
# 关键：Windows 下 huggingface_hub 默认用符号链接，读取时会得到空文件导致模型加载失败，
#       必须禁用它改用真实拷贝（实测踩过这个坑）
$env:HF_HUB_DISABLE_SYMLINKS = '1'
foreach ($pair in @(
    @('PIP_CACHE_DIR',$dirs.PipCache),
    @('CARGO_HOME',$dirs.CargoHome),
    @('RUSTUP_HOME',$dirs.RustupHome),
    @('CARGO_TARGET_DIR',$dirs.CargoTarget),
    @('npm_config_cache',$dirs.NpmCache),
    @('HF_HOME',$dirs.HfCache),
    @('TORCH_HOME',$dirs.TorchCache),
    @('HF_HUB_DISABLE_SYMLINKS','1'))) {
    try { [Environment]::SetEnvironmentVariable($pair[0], $pair[1], 'User') } catch { }
}

function Write-Log { param([string]$m)
    try { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Add-Content -Path $script:LogFile -Encoding UTF8 } catch { }
}

# ============================ 心跳执行器 ============================
function Invoke-Heartbeat {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][scriptblock]$Script,
        [object[]]$Arguments = @(),
        [int]$IntervalSeconds = 0
    )
    if ($IntervalSeconds -le 0) { $IntervalSeconds = $script:HeartbeatSec }
    $sw  = [System.Diagnostics.Stopwatch]::StartNew()
    $job = Start-Job -ScriptBlock $Script -ArgumentList $Arguments
    while ($job.State -eq 'Running') {
        Start-Sleep -Seconds $IntervalSeconds
        if ($job.State -eq 'Running') {
            $el = [int]$sw.Elapsed.TotalSeconds
            Beat ("[{0}] {1} 仍在正常运行中… 已耗时 {2}分{3:D2}秒（不是卡死，请耐心等待）" -f `
                  (Get-Date -Format 'HH:mm:ss'), $Name, [int]($el/60), ($el % 60))
        }
    }
    $out = (Receive-Job $job 2>&1 | Out-String).Trim()
    $state = $job.State
    Remove-Job $job -Force
    $sw.Stop()
    $looksFailed = $out -match '(?im)(^\s*ERROR\b|ERROR:|error: |No matching distribution|Could not find a version|Failed building wheel|拒绝访问|Access is denied|not recognized)'
    Write-Log "[$Name] state=$state elapsed=$([int]$sw.Elapsed.TotalSeconds)s failed=$looksFailed"
    return [pscustomobject]@{
        Output  = $out
        Elapsed = $sw.Elapsed
        Success = ($state -eq 'Completed' -and -not $looksFailed)
    }
}

# ============================ 带进度条下载 ============================
function Get-Download {
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$OutFile,
        [long]$ExpectedBytes = 0,
        [string]$Label = ''
    )
    if ([string]::IsNullOrWhiteSpace($Label)) { $Label = Split-Path $OutFile -Leaf }
    $dir = Split-Path $OutFile -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    if (Test-Path $OutFile) { Remove-Item $OutFile -Force -ErrorAction SilentlyContinue }

    $job = Start-Job -ScriptBlock {
        param($u, $o)
        try {
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $u -OutFile $o -UseBasicParsing -TimeoutSec 7200
            'OK'
        } catch { "ERR|$($_.Exception.Message)" }
    } -ArgumentList $Url, $OutFile

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $lastBeat = 0
    while ($job.State -eq 'Running') {
        Start-Sleep -Milliseconds 800
        $cur = 0
        if (Test-Path $OutFile) { try { $cur = (Get-Item $OutFile).Length } catch { $cur = 0 } }
        $el = $sw.Elapsed.TotalSeconds
        $mb = $cur / 1MB
        if ($ExpectedBytes -gt 0) {
            $pct = [Math]::Min(100, [int]($cur * 100 / $ExpectedBytes))
            $barW = 26; $fill = [int]($barW * $pct / 100)
            $bar = ('#' * $fill) + ('.' * ($barW - $fill))
            $spd = 0.0; if ($el -gt 0.5) { $spd = $mb / $el }
            [Console]::Write("`r      $Label [$bar] {0,3}%  {1,7:N1}/{2,7:N1} MB  {3,5:N1} MB/s      " -f `
                $pct, $mb, ($ExpectedBytes/1MB), $spd)
        } else {
            [Console]::Write("`r      $Label  已下载 {0,8:N1} MB   耗时 {1:N0}s      " -f $mb, $el)
        }
        if (($el - $lastBeat) -ge $script:HeartbeatSec) {
            $lastBeat = $el
            [Console]::WriteLine('')
            Beat ("[{0}] {1} 仍在正常下载中…（不是卡死）" -f (Get-Date -Format 'HH:mm:ss'), $Label)
        }
    }
    [Console]::WriteLine('')
    $res = (Receive-Job $job 2>&1 | Out-String).Trim()
    Remove-Job $job -Force
    $sw.Stop()
    if ($res -like 'OK*' -and (Test-Path $OutFile)) {
        $sz = (Get-Item $OutFile).Length
        if ($ExpectedBytes -gt 0 -and $sz -ne $ExpectedBytes) {
            Warn "$Label 大小不符（实际 $sz / 期望 $ExpectedBytes），可能不完整"
        }
        Ok ("$Label 下载完成（{0:N1} MB，耗时 {1:N0}s）" -f ($sz/1MB), $sw.Elapsed.TotalSeconds)
        Write-Log "[下载] $Label -> $OutFile ($sz bytes)"
        return $true
    }
    Fail "$Label 下载失败：$res"
    Write-Log "[下载失败] $Label : $res"
    return $false
}

# ============================ 探测辅助 ============================
function Get-CmdPath { param([string]$n)
    $c = Get-Command $n -ErrorAction SilentlyContinue
    if ($c) { return $c.Source } else { return $null } }
function Test-Cmd { param([string]$n) return [bool](Get-CmdPath $n) }
function Test-Admin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false } }
function Test-Net { param([string]$u = 'https://pypi.org')
    try { $r = Invoke-WebRequest -Uri $u -Method Head -TimeoutSec 12 -UseBasicParsing
          return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) } catch { return $false } }
function Get-FreeGB { param([string]$drive)
    try { return [Math]::Round((Get-PSDrive -Name $drive.TrimEnd(':')).Free / 1GB, 1) } catch { return -1 } }

# ============================ 开场 ============================
try { Clear-Host } catch { }
Write-Host ''
Write-Host '  ====================================================================' -ForegroundColor Cyan
Write-Host '        油棕园空地智能检测 · 环境配置向导 (Forest Gap Detection)'      -ForegroundColor Cyan
Write-Host '  ====================================================================' -ForegroundColor Cyan
Write-Host ''
Say "  启动时间   : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" DarkGray
Say "  运行模式   : $(if ($CheckOnly) {'仅检测（不做安装）'} else {'检测 + 自动安装'})" DarkGray
Say "  镜像加速   : $(if ($UseChinaMirror) {'已开启（国内源）'} else {'关闭（官方源）'})" DarkGray
Say "  数据盘     : ${DataDrive}:   工具安装目录 : $InstallRoot" DarkGray
Say "  心跳间隔   : $($script:HeartbeatSec) 秒" DarkGray
Write-Host ''

$isAdmin = Test-Admin
if ($isAdmin) { Ok '当前以管理员身份运行（可选组件也能装）' }
else { Warn '普通用户权限 —— 脚本将走「用户级安装」路线，多数组件无需管理员' }

# ---------------------------------------------------------------
Title '阶段 1/6 · 系统与磁盘检测'
# ---------------------------------------------------------------
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
if ($os) { Ok "操作系统：$($os.Caption)  (Build $($os.BuildNumber))  $($os.OSArchitecture)" }
else { Info '未能读取系统信息（不影响后续步骤）' }

$sysFree = Get-FreeGB $env:SystemDrive
$dataFree = Get-FreeGB $DataDrive
if ($sysFree -ge 0) {
    if ($sysFree -lt 20) { Warn "系统盘 $($env:SystemDrive) 剩余仅 ${sysFree} GB —— 已自动把大体积产物指向 ${DataDrive}: 盘" }
    else { Ok "系统盘 $($env:SystemDrive) 剩余 ${sysFree} GB" }
}
if ($dataFree -ge 0) {
    if ($dataFree -lt 20) { Fail "数据盘 ${DataDrive}: 剩余仅 ${dataFree} GB —— 完整安装约需 15~20 GB，请先清理！" }
    else { Ok "数据盘 ${DataDrive}: 剩余 ${dataFree} GB（venv / 缓存 / 模型 / 编译产物都将放在这里）" }
}

$netOK = Test-Net
if ($netOK) { Ok '网络连通性：正常' } else { Fail '网络不通 —— 请检查代理 / 防火墙后再运行' }

# ---------------------------------------------------------------
Title '阶段 2/6 · 基础工具链检测'
# ---------------------------------------------------------------
if (Test-Cmd 'git') {
    $gv = (& (Get-CmdPath 'git') --version 2>&1) -join ' '
    Ok "Git：$gv"; Add-Result 'Git' '已安装' $gv
} else {
    Fail 'Git：未安装'; Add-Result 'Git' '缺失' '版本控制'
    Add-Manual 'Git for Windows' 'https://git-scm.com/download/win' '下载 64-bit 安装包；或使用便携版 PortableGit 解压即用'
}

$pythonExe = $null; $pythonVer = $null; $pythonAiOK = $false
foreach ($cand in @('python','python3','py')) {
    if (Test-Cmd $cand) {
        try {
            $v = ((& (Get-CmdPath $cand) -c "import sys;print('.'.join(map(str,sys.version_info[:3])))" 2>&1) -join '').Trim()
            if ($v -match '^\d+\.\d+\.\d+$') {
                $mj = [int]($v.Split('.')[0]); $mn = [int]($v.Split('.')[1])
                if ($mj -ge 3 -and $mn -ge 10) {
                    $pythonExe = Get-CmdPath $cand; $pythonVer = $v
                    # PyTorch 官方 wheel 目前覆盖 3.10~3.13；3.14+ 可能装不上 GPU 版
                    if ($mn -le 13) { $pythonAiOK = $true }
                    break
                } else { Warn "Python $v 版本偏低（需 3.10+）" }
            }
        } catch { }
    }
}
if ($pythonExe) {
    Ok "Python：$pythonVer  ($pythonExe)"
    Add-Result 'Python' '已安装' $pythonVer
    if (-not $pythonAiOK) {
        Warn "Python $pythonVer 版本过新 —— PyTorch 官方 wheel 目前覆盖 3.10~3.13，脚本会另外装一个 Python 3.12 专供 AI 环境"
        Add-Result 'Python (AI 环境)' '需替换' '将自动装 3.12 供 PyTorch 使用' 'AI 必需'
    }
} else {
    Fail 'Python 3.10+：未找到'; Add-Result 'Python' '缺失' '需 3.10 或更高'
    Info '脚本可尝试自动安装（用户级，装到 D 盘）'
}

$nodeExe = $null
if (Test-Cmd 'node') {
    $nv = ((& (Get-CmdPath 'node') -v 2>&1) -join '').Trim() -replace '^v',''
    $nodeExe = Get-CmdPath 'node'
    Ok "Node.js：v$nv"; Add-Result 'Node.js' '已安装' "v$nv" '前端必需'
} else {
    Fail 'Node.js：未安装'; Add-Result 'Node.js' '缺失' '前端构建' '前端必需'
}
$npmPath = Get-CmdPath 'npm'
if ($npmPath) {
    $npmVer = ''
    try {
        $npmCmd = Join-Path (Split-Path $npmPath -Parent) 'npm.cmd'
        if (Test-Path $npmCmd) { $npmVer = ((& $npmCmd -v 2>&1) -join '').Trim() }
        else { $npmVer = ((& $npmPath -v 2>&1) -join '').Trim() }
    } catch { $npmVer = '' }
    if ($npmVer -match '^\d+\.\d+') { Ok "npm：v$npmVer" }
    else { Ok 'npm：已安装（版本号读取被执行策略阻止，不影响使用）' }
} else { Warn 'npm：未找到（随 Node.js 一起装）' }

$rustOK = $false; $rustNeedRepair = $false
if (Test-Cmd 'rustc') {
    $rv = ((& (Get-CmdPath 'rustc') --version 2>&1) -join ' ').Trim()
    if ($rv -match '^rustc \d') {
        Ok "Rust：$rv"; Add-Result 'Rust' '已安装' $rv '桌面端必需'; $rustOK = $true
    } else {
        Warn 'Rust 已安装，但 rustup 未设置默认工具链（rustc 无法运行）'
        Add-Result 'Rust' '需修复' 'rustup 未设置默认工具链，脚本会自动修复' '桌面端必需'
        $rustNeedRepair = $true
    }
} else {
    Fail 'Rust：未安装'; Add-Result 'Rust' '缺失' 'Tauri 后端' '桌面端必需'
}

$linkOK = $false
if (Test-Cmd 'link') { $linkOK = $true }
if (-not $linkOK) {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $vc = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($vc) { $linkOK = $true; Ok "MSVC C++ 生成工具：$vc" }
    }
}
if ($linkOK) { Add-Result 'MSVC 生成工具' '已安装' 'Rust MSVC 工具链可用' '桌面端推荐' }
else {
    Warn 'MSVC C++ 生成工具：未找到 —— 脚本会改用 GNU 工具链（免管理员，可正常构建）'
    Add-Result 'MSVC 生成工具' '缺失' '已用 GNU 工具链替代，不影响使用' '可选'
    # 只有在确实需要 MSVC 时再提示手动安装；GNU 工具链已能覆盖 Tauri 构建
    # Add-Manual 'Visual Studio Build Tools 2022' 'https://visualstudio.microsoft.com/visual-cpp-build-tools/' '勾选「使用 C++ 的桌面开发」；需管理员'
}

$wv2 = $null
foreach ($k in @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}')) {
    try { $p = Get-ItemProperty -Path $k -ErrorAction Stop; if ($p.pv) { $wv2 = $p.pv; break } } catch { }
}
if ($wv2) { Ok "WebView2 运行时：$wv2"; Add-Result 'WebView2' '已安装' $wv2 '桌面端必需' }
else {
    Warn 'WebView2 运行时：未检测到'
    Add-Result 'WebView2' '缺失' 'Win11 通常自带' '桌面端必需'
    Add-Manual 'WebView2 Evergreen Runtime' 'https://developer.microsoft.com/microsoft-edge/webview2/' '选 Evergreen Standalone Installer；需管理员'
}

# ---------------------------------------------------------------
Title '阶段 3/6 · GPU 与 AI 硬件检测'
# ---------------------------------------------------------------
$gpuName = $null
$smi = Get-CmdPath 'nvidia-smi'
if (-not $smi) {
    foreach ($p in @("$env:SystemRoot\System32\nvidia-smi.exe",
                     "$env:ProgramFiles\NVIDIA Corporation\NVSMI\nvidia-smi.exe")) {
        if (Test-Path $p) { $smi = $p; break }
    }
}
if ($smi) {
    $out = & $smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>&1
    if ($out) {
        $parts = (($out | Select-Object -First 1) -split ',')
        if ($parts.Count -ge 3) {
            $gpuName = $parts[0].Trim()
            Ok "NVIDIA GPU：$gpuName"
            Ok "驱动版本：$($parts[1].Trim())    显存：$($parts[2].Trim())"
            Add-Result 'NVIDIA GPU' '已安装' "$gpuName / 驱动 $($parts[1].Trim()) / $($parts[2].Trim())" '推荐'
        }
        $cv = (& $smi 2>&1 | Select-String 'CUDA Version' | Select-Object -First 1)
        if ($cv) { Info "驱动支持的最高 CUDA 版本：$(($cv -split 'CUDA Version:')[1].Trim().Split(' ')[0])" }
    }
} else {
    Warn '未检测到 NVIDIA GPU（nvidia-smi 不存在）—— CPU 推理可用但较慢'
    Add-Result 'NVIDIA GPU' '缺失' 'CPU 推理可用但较慢' '推荐'
}
if (Test-Cmd 'nvcc') { Ok 'CUDA Toolkit：已安装' }
else { Info 'CUDA Toolkit：未单独安装 —— 不影响（pip 版 PyTorch 自带 CUDA 运行时）' }
if (Test-Cmd 'docker') {
    $dv = ((& (Get-CmdPath 'docker') --version 2>&1) -join ' ').Trim()
    Ok "Docker：$dv"; Add-Result 'Docker' '已安装' $dv '可选'
} else {
    # Docker 目前不是本项目所需（桌面端必须在宿主机构建，推理用原生环境即可）。
    # 若将来要做「训练环境团队统一」或「云端批量处理」，再启用下面这段。
    # Info 'Docker：未安装（可选方案，见 docs/docker-alternative.md）'
    # Add-Result 'Docker' '缺失' '可选替代方案' '可选'
    # Add-Manual 'Docker Desktop' 'https://www.docker.com/products/docker-desktop/' '需管理员 + WSL2；Docker 镜像也可改到 D 盘'
}

if ($CheckOnly) {
    Write-Host ''
    Warn '当前为「仅检测」模式，跳过所有安装步骤（不会修改系统）。'
}

# ===============================================================
if (-not $CheckOnly) {

# ---------------------------------------------------------------
Title '阶段 4/6 · 基础工具安装（用户级 · 全部装到 D 盘）'
# ---------------------------------------------------------------

# --- Python 自动安装（系统没有 Python，或系统 Python 过新导致 PyTorch 装不上时）---
$pythonForVenv = $pythonExe
if (-not $pythonExe -or -not $pythonAiOK) {
    $pyVer = '3.12.9'
    $pyInstaller = Join-Path $dirs.Downloads "python-$pyVer-amd64.exe"
    $pyTarget = Join-Path $InstallRoot 'python312'
    $pyUrl = "https://www.python.org/ftp/python/$pyVer/python-$pyVer-amd64.exe"
    if ($pythonExe) { Act "系统 Python $pythonVer 过新，额外装一个 Python $pyVer 专供 AI 环境（用户级 -> $pyTarget）" }
    else { Act "自动安装 Python $pyVer（用户级，安装到 $pyTarget）" }
    if (Get-Download -Url $pyUrl -OutFile $pyInstaller -Label "Python $pyVer 安装包") {
        $pyArgs = @('/quiet','InstallAllUsers=0',"TargetDir=$pyTarget",'PrependPath=0','Include_launcher=0','Include_pip=1','Include_test=0')
        $r = Invoke-Heartbeat -Name 'Python 安装程序' -Script {
            param($exe,$a) & $exe @a 2>&1 | Out-String
        } -Arguments @($pyInstaller,$pyArgs)
        $cand = Join-Path $pyTarget 'python.exe'
        if (Test-Path $cand) {
            $pythonForVenv = $cand
            $newVer = ((& $cand -c "import sys;print('.'.join(map(str,sys.version_info[:3])))" 2>&1) -join '').Trim()
            Ok "Python $newVer 安装成功（将用于 AI 虚拟环境）"
            Add-Result 'Python (AI 环境)' '已安装' "$newVer @ $pyTarget"
            if (-not $pythonExe) {
                $pythonExe = $cand; $pythonVer = $newVer
                $env:Path = "$pyTarget;$pyTarget\Scripts;$env:Path"
            }
        } else {
            Fail 'Python 自动安装未成功，请手动安装'
            Add-Manual 'Python 3.12' $pyUrl '安装时勾选 Add python.exe to PATH'
        }
    } else {
        Add-Manual 'Python 3.12' $pyUrl '手动下载安装，勾选 Add python.exe to PATH'
    }
}

# --- Node.js 自动安装（便携版，解压即用，免管理员）---
if (-not (Test-Cmd 'node') -and -not $SkipNode) {
    $nodeVer = '20.18.1'
    $nodeZip = Join-Path $dirs.Downloads "node-v$nodeVer-win-x64.zip"
    $nodeDir = Join-Path $InstallRoot "node-v$nodeVer-win-x64"
    $nodeUrl = "https://nodejs.org/dist/v$nodeVer/node-v$nodeVer-win-x64.zip"
    if ($UseChinaMirror) { $nodeUrl = "https://npmmirror.com/mirrors/node/v$nodeVer/node-v$nodeVer-win-x64.zip" }
    Act "自动安装 Node.js v$nodeVer（便携版解压到 $nodeDir）"
    if (Get-Download -Url $nodeUrl -OutFile $nodeZip -Label "Node.js v$nodeVer") {
        $r = Invoke-Heartbeat -Name '解压 Node.js' -Script {
            param($zip,$dst) 
            Expand-Archive -Path $zip -DestinationPath (Split-Path $dst -Parent) -Force
            'done'
        } -Arguments @($nodeZip,(Split-Path $nodeDir -Parent))
        if (Test-Path (Join-Path $nodeDir 'node.exe')) {
            $env:Path = "$nodeDir;$env:Path"
            $userPath = [Environment]::GetEnvironmentVariable('Path','User')
            if ($userPath -notlike "*$nodeDir*") {
                [Environment]::SetEnvironmentVariable('Path', "$userPath;$nodeDir", 'User')
            }
            Ok "Node.js 安装成功：$(((& (Join-Path $nodeDir 'node.exe') -v 2>&1) -join '').Trim())"
            Add-Result 'Node.js' '已安装' "v$nodeVer (便携版, D 盘)"
        } else { Fail 'Node.js 解压失败'; Add-Manual 'Node.js' $nodeUrl '手动下载 zip 解压并加入 PATH' }
    } else { Add-Manual 'Node.js' $nodeUrl '手动下载 zip 解压并加入 PATH' }
}

# --- Rust：已装但缺默认工具链 → 先修复 ---
if (-not $rustOK -and $rustNeedRepair -and -not $SkipRust) {
    Act 'Rust 已安装但缺少默认工具链，执行 rustup default stable（会自动下载，请耐心等待）'
    $r = Invoke-Heartbeat -Name 'rustup default stable' -Script {
        & rustup default stable 2>&1 | Out-String
    } -Arguments @() -IntervalSeconds 30
    $rv2 = ((& (Get-CmdPath 'rustc') --version 2>&1) -join ' ').Trim()
    if ($rv2 -match '^rustc \d') { Ok "Rust 修复成功：$rv2"; $rustOK = $true }
    else { Warn 'Rust 修复未成功，请手动执行： rustup default stable' }
}

# --- Rust 工具链（rustup 用户级全新安装，免管理员）---
if (-not $rustOK -and -not $rustNeedRepair -and -not $SkipRust) {
    $rustupExe = Join-Path $dirs.Downloads 'rustup-init.exe'
    $rustupUrl = 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe'
    if ($UseChinaMirror) { $rustupUrl = 'https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' }
    Act "自动安装 Rust 工具链（RUSTUP_HOME=$($dirs.RustupHome)）"
    if (Get-Download -Url $rustupUrl -OutFile $rustupExe -Label 'rustup-init.exe') {
        # 优先 MSVC（需 VS 生成工具），否则用 GNU 工具链（自带链接器，免管理员）
        $toolchain = 'stable-x86_64-pc-windows-msvc'
        if (-not $linkOK) {
            $toolchain = 'stable-x86_64-pc-windows-gnu'
            Warn '未检测到 MSVC 链接器 → 改用 GNU 工具链（自带 MinGW 链接器，无需管理员）'
        }
        $rargs = @('-y','--no-modify-path','--default-toolchain',$toolchain,'--profile','default')
        $r = Invoke-Heartbeat -Name 'Rust 工具链下载安装' -Script {
            param($exe,$a) & $exe @a 2>&1 | Out-String
        } -Arguments @($rustupExe,$rargs) -IntervalSeconds 30
        $cargoBin = Join-Path $dirs.CargoHome 'bin'
        if (Test-Path (Join-Path $cargoBin 'cargo.exe')) {
            $env:Path = "$cargoBin;$env:Path"
            $userPath = [Environment]::GetEnvironmentVariable('Path','User')
            if ($userPath -notlike "*$cargoBin*") {
                [Environment]::SetEnvironmentVariable('Path', "$userPath;$cargoBin", 'User')
            }
            Ok "Rust 安装成功：$toolchain"
            Add-Result 'Rust' '已安装' "$toolchain (D 盘)"
        } else {
            Fail 'Rust 安装未成功'
            Add-Manual 'Rust (rustup)' 'https://rustup.rs/' '下载 rustup-init.exe 运行；安装前先设置 CARGO_HOME / RUSTUP_HOME 到 D 盘'
        }
    } else { Add-Manual 'Rust (rustup)' 'https://rustup.rs/' '手动下载 rustup-init.exe' }
}

# --- Git 提示 ---
if (-not (Test-Cmd 'git')) {
    Warn 'Git 未安装 —— 不影响 AI 检测，但影响代码版本管理'
}

# ---------------------------------------------------------------
Title '阶段 5/6 · Python 虚拟环境与依赖'
# ---------------------------------------------------------------
$projRoot = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot }
            elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
            else { (Get-Location).Path }
$venvDir  = Join-Path $projRoot '.venv'

if (-not $pythonForVenv) {
    Fail 'Python 缺失，跳过 Python 环境安装。请手动安装 Python 后重新运行本脚本。'
    Add-Result 'Python venv' '跳过' 'Python 未安装'
} else {
    if (Test-Path (Join-Path $venvDir 'Scripts\python.exe')) {
        Ok "虚拟环境已存在：$venvDir"
    } else {
        Act "创建虚拟环境（在 D 盘项目目录内）：$venvDir"
        $r = Invoke-Heartbeat -Name '创建 venv' -Script {
            param($py,$dir) & $py -m venv $dir 2>&1 | Out-String
        } -Arguments @($pythonForVenv,$venvDir)
        if (Test-Path (Join-Path $venvDir 'Scripts\python.exe')) { Ok '虚拟环境创建完成' }
        else { Fail '虚拟环境创建失败' }
    }
    $vpy = Join-Path $venvDir 'Scripts\python.exe'
    if (Test-Path $vpy) {
        $mirrorArgs = @()
        if ($UseChinaMirror) { $mirrorArgs = @('-i','https://pypi.tuna.tsinghua.edu.cn/simple') }

        Act '升级 pip / wheel / setuptools'
        $r = Invoke-Heartbeat -Name 'pip 自升级' -Script {
            param($py,$a) & $py @a 2>&1 | Out-String
        } -Arguments @($vpy, (@('-m','pip','install','--upgrade','pip','wheel','setuptools') + $mirrorArgs))
        if ($r.Success) { Ok "完成（耗时 $([int]$r.Elapsed.TotalSeconds) 秒）" } else { Warn "pip 升级有告警，可继续" }

        # ONNX Runtime 同样按有无 GPU 选择版本
        $onnxPkg = 'onnxruntime'
        $onnxLabel = 'AI 运行时 ONNX（CPU 版）'
        if ($gpuName) { $onnxPkg = 'onnxruntime-gpu'; $onnxLabel = 'AI 运行时 ONNX（GPU 版）' }
        $pkgGroups = @(
            @{ n='基础科学计算';            p=@('numpy','scipy','pandas') },
            @{ n='地理处理（自带 GDAL）';    p=@('rasterio','shapely','pyproj','pyogrio') },
            @{ n='图像处理';                p=@('pillow','opencv-python-headless') },
            @{ n=$onnxLabel;               p=@($onnxPkg) }
        )
        foreach ($g in $pkgGroups) {
            if ($g.n -like '*AI*' -and $SkipAI) { Info "已指定 -SkipAI，跳过 $($g.n)"; continue }
            Act "安装：$($g.n)  ->  $($g.p -join ', ')"
            $r = Invoke-Heartbeat -Name "pip 安装 $($g.n)" -Script {
                param($py,$a) & $py @a 2>&1 | Out-String
            } -Arguments @($vpy, (@('-m','pip','install') + $g.p + $mirrorArgs))
            if ($r.Success) {
                Ok "完成（耗时 $([int]$r.Elapsed.TotalSeconds) 秒）"
                Add-Result "pip: $($g.n)" '已安装' ($g.p -join ', ')
            } else {
                Warn "$($g.n) 可能未装成功"
                Add-Result "pip: $($g.n)" '失败' '可重试或查看日志'
                Beat "输出末尾：$((($r.Output -split "`n") | Select-Object -Last 4) -join ' | ')"
            }
        }

        # 验证 GDAL
        $gdalCheck = (& $vpy -c "import rasterio;print(rasterio.__gdal_version__)" 2>&1) -join ''
        if ($gdalCheck -match '^\d+\.\d+') {
            Ok "GDAL 可用（版本 $gdalCheck.Trim()，由 rasterio 自带，无需系统安装）"
            Add-Result 'GDAL' '已安装' "v$($gdalCheck.Trim()) (随 rasterio)" 
        } else { Warn 'GDAL 未能加载，请检查 rasterio 安装' ; Add-Result 'GDAL' '失败' 'rasterio 未装好' }

        # --- GPU 版 PyTorch ---
        if (-not $SkipAI) {
            $hasTorch = (& $vpy -c "import torch;print(torch.__version__)" 2>$null) -join ''
            # 策略：优先 GPU，检测不到显卡才降级 CPU
            if ($gpuName) {
                Info "检测到 NVIDIA GPU（$gpuName）→ 优先安装 GPU 版 PyTorch"
            } else {
                Info '未检测到 NVIDIA GPU → 降级安装 CPU 版 PyTorch'
                Info '（换到有独立显卡的机器上重跑本脚本，会自动改用 GPU 版）'
            }
            if ($hasTorch) {
                Ok "PyTorch 已安装：$hasTorch"
            } elseif ($gpuName) {
                Act '安装 GPU 版 PyTorch（约 2.5 GB，将解压到 D 盘 venv，请耐心等待）'
                Info 'pip 版 PyTorch 自带 CUDA 运行时，无需单独安装 CUDA Toolkit'
                $a = @('-m','pip','install','torch','torchvision','--index-url','https://download.pytorch.org/whl/cu121')
                if ($UseChinaMirror) {
                    $a = @('-m','pip','install','torch','torchvision',
                           '-i','https://pypi.tuna.tsinghua.edu.cn/simple',
                           '--extra-index-url','https://download.pytorch.org/whl/cu121')
                }
                $r = Invoke-Heartbeat -Name 'PyTorch (CUDA)' -Script {
                    param($py,$a) & $py @a 2>&1 | Out-String
                } -Arguments @($vpy,$a) -IntervalSeconds 30
                if ($r.Success) {
                    $v = ((& $vpy -c "import torch;print(torch.__version__,'| CUDA:',torch.cuda.is_available())" 2>&1) -join '').Trim()
                    Ok "PyTorch 安装完成：$v"
                    Add-Result 'PyTorch (CUDA)' '已安装' $v
                } else {
                    Warn 'PyTorch 安装可能失败，可稍后重试'
                    Add-Result 'PyTorch (CUDA)' '失败' '可重试；或改用 CPU 版'
                }
            } else {
                Act '未检测到 GPU，安装 CPU 版 PyTorch（体积小很多）'
                $r = Invoke-Heartbeat -Name 'PyTorch (CPU)' -Script {
                    param($py,$a) & $py @a 2>&1 | Out-String
                } -Arguments @($vpy, @('-m','pip','install','torch','torchvision','--index-url','https://download.pytorch.org/whl/cpu')) -IntervalSeconds 30
                if ($r.Success) { Ok 'PyTorch (CPU) 安装完成'; Add-Result 'PyTorch (CPU)' '已安装' '无 GPU 环境' }
                else { Warn 'PyTorch (CPU) 安装失败'; Add-Result 'PyTorch (CPU)' '失败' '' }
            }
        } else { Info '已指定 -SkipAI，跳过 PyTorch' }
    }
}

# ---------------------------------------------------------------
Title '阶段 6/6 · 模型权重与前端依赖'
# ---------------------------------------------------------------
$models = @(
    @{ path='models\deepforest-tree\model.safetensors'; name='DeepForest 树冠检测权重';
       url='https://huggingface.co/weecology/deepforest-tree/resolve/main/model.safetensors';
       size=129049980; note='MIT 许可 · 123 MB' },
    @{ path='models\deepforest-tree\config.json'; name='DeepForest 配置';
       url='https://huggingface.co/weecology/deepforest-tree/resolve/main/config.json';
       size=235; note='' },
    @{ path='models\sam2\sam2.1_hiera_base_plus.pt'; name='SAM 2.1 分割权重';
       url='https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_base_plus.pt';
       size=323606802; note='Apache 2.0 许可 · 308 MB' }
)
if ($SkipModels) { Info '已指定 -SkipModels，跳过模型下载' }
else {
    foreach ($m in $models) {
        $full = Join-Path $projRoot $m.path
        if ((Test-Path $full) -and ((Get-Item $full).Length -eq $m.size)) {
            Ok "$($m.name) 已就绪（$([Math]::Round((Get-Item $full).Length/1MB,1)) MB）"
            Add-Result $m.name '已安装' "$([Math]::Round($m.size/1MB,1)) MB"
        } else {
            Act "下载 $($m.name)  $($m.note)"
            if (Get-Download -Url $m.url -OutFile $full -ExpectedBytes $m.size -Label $m.name) {
                Add-Result $m.name '已安装' "$([Math]::Round($m.size/1MB,1)) MB"
            } else {
                Add-Result $m.name '失败' '请手动下载'
                Add-Manual $m.name $m.url "手动下载后放到：$full"
            }
        }
    }
}

if (-not $SkipNode -and (Test-Cmd 'npm')) {
    $pkgJson = Join-Path $projRoot 'package.json'
    if (Test-Path $pkgJson) {
        Act '安装前端依赖（npm install，缓存已指向 D 盘）'
        $r = Invoke-Heartbeat -Name 'npm install' -Script {
            param($root,$mirror)
            Push-Location $root
            try {
                if ($mirror) { & npm config set registry https://registry.npmmirror.com | Out-Null }
                & npm install 2>&1 | Out-String
            } finally { Pop-Location }
        } -Arguments @($projRoot,[bool]$UseChinaMirror) -IntervalSeconds 30
        if ($r.Success) { Ok '前端依赖安装完成'; Add-Result 'npm 依赖' '已安装' 'package.json' }
        else { Warn '前端依赖安装失败'; Add-Result 'npm 依赖' '失败' '可稍后重试' }
    } else {
        Info 'package.json 尚不存在（前端未初始化），跳过 npm install'
        Add-Result 'npm 依赖' '跳过' 'package.json 不存在' '前端必需'
    }
}

} # end if (-not $CheckOnly)

# ---------------------------------------------------------------
Title '环境检测报告'
# ---------------------------------------------------------------

Write-Host ''
Write-Host ('  {0,-28} {1,-8} {2}' -f '组件','状态','说明') -ForegroundColor White
Write-Host ('  ' + ('-' * 72)) -ForegroundColor DarkGray
foreach ($r in $script:Results) {
    $color = 'Gray'
    if ($r.Status -eq '已安装') { $color = 'Green' }
    elseif ($r.Status -eq '缺失') { $color = 'Red' }
    elseif ($r.Status -eq '失败') { $color = 'Yellow' }
    elseif ($r.Status -eq '跳过') { $color = 'DarkGray' }
    Write-Host ('  {0,-28} {1,-8} {2}' -f $r.Component, $r.Status, $r.Detail) -ForegroundColor $color
}
Write-Host ''

$total = $script:Results.Count
$okN   = @($script:Results | Where-Object { $_.Status -eq '已安装' }).Count
$missN = @($script:Results | Where-Object { $_.Status -eq '缺失' }).Count
$failN = @($script:Results | Where-Object { $_.Status -eq '失败' }).Count
$skipN = @($script:Results | Where-Object { $_.Status -eq '跳过' }).Count
$pct = 0; if ($total -gt 0) { $pct = [int]($okN * 100 / $total) }

Say "  已就绪 $okN 项 / 共 $total 项     完成度 $pct%" Cyan
if ($missN) { Say "  缺失 $missN 项" Red }
if ($failN) { Say "  失败 $failN 项" Yellow }
if ($skipN) { Say "  跳过 $skipN 项" DarkGray }

if ($script:ManualList.Count -gt 0) {
    Write-Host ''
    Write-Host '  ── 需要手动下载 / 安装的组件 ──' -ForegroundColor Yellow
    foreach ($m in $script:ManualList) {
        Write-Host "   * $($m.Component)" -ForegroundColor Yellow
        Write-Host "     下载：$($m.Url)" -ForegroundColor DarkGray
        Write-Host "     说明：$($m.Why)" -ForegroundColor DarkGray
    }
}

Write-Host ''
Write-Host '  ── 磁盘占用提示 ──' -ForegroundColor Cyan
Say "   工具链目录 : $InstallRoot" Gray
Say "   Python 环境 : $projRoot\.venv" Gray
Say "   模型权重   : $projRoot\models" Gray
Say "   Rust 编译产物 : $($dirs.CargoTarget)" Gray

Write-Host ''
Write-Host '  ── 下一步该做什么 ──' -ForegroundColor Cyan
if ($missN -eq 0 -and $failN -eq 0) {
    Write-Host '   环境已就绪！可以开始开发：' -ForegroundColor Green
    Write-Host '     * 激活 Python 环境 : .venv\Scripts\activate' -ForegroundColor Gray
    Write-Host '     * 启动前端          : npm run dev' -ForegroundColor Gray
    Write-Host '     * 启动桌面应用      : npm run tauri dev' -ForegroundColor Gray
} else {
    Write-Host '   1) 先处理上面「缺失 / 失败」的组件（手动安装的可能需要管理员）' -ForegroundColor Gray
    Write-Host '   2) 重新运行本脚本，已装好的会自动跳过，只补装缺的' -ForegroundColor Gray
    Write-Host '       双击「一键配置环境.bat」，或执行：' -ForegroundColor Gray
    Write-Host '       powershell -ExecutionPolicy Bypass -File scripts\配置环境.ps1' -ForegroundColor Gray
}

# ---- 写 Markdown 报告 ----
try {
    $mdDir = Split-Path $ReportPath -Parent
    if ($mdDir -and -not (Test-Path $mdDir)) { New-Item -ItemType Directory -Path $mdDir -Force | Out-Null }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('# 环境检测报告')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine("> 生成时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
    [void]$sb.AppendLine("> 机器：$env:COMPUTERNAME · 用户：$env:USERNAME · 管理员权限：$(if($isAdmin){'是'}else{'否'})")
    [void]$sb.AppendLine("> 数据盘：${DataDrive}: · 工具目录：``$InstallRoot``")
    [void]$sb.AppendLine("> 完成度：$okN / $total （$pct%）")
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('| 组件 | 状态 | 说明 | 必要性 |')
    [void]$sb.AppendLine('|---|---|---|---|')
    foreach ($r in $script:Results) {
        $icon = '⚪'
        if ($r.Status -eq '已安装') { $icon = '✅' } elseif ($r.Status -eq '缺失') { $icon = '❌' } elseif ($r.Status -eq '失败') { $icon = '⚠️' }
        [void]$sb.AppendLine("| $($r.Component) | $icon $($r.Status) | $($r.Detail) | $($r.Required) |")
    }
    if ($script:ManualList.Count -gt 0) {
        [void]$sb.AppendLine('')
        [void]$sb.AppendLine('## 需要手动下载 / 安装')
        [void]$sb.AppendLine('')
        [void]$sb.AppendLine('| 组件 | 下载地址 | 说明 |')
        [void]$sb.AppendLine('|---|---|---|')
        foreach ($m in $script:ManualList) { [void]$sb.AppendLine("| $($m.Component) | <$($m.Url)> | $($m.Why) |") }
    }
    if ($script:Warnings.Count -gt 0) {
        [void]$sb.AppendLine('')
        [void]$sb.AppendLine('## 警告记录')
        [void]$sb.AppendLine('')
        foreach ($w in $script:Warnings) { [void]$sb.AppendLine("- $w") }
    }
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('---')
    [void]$sb.AppendLine("*由 setup_env.ps1 自动生成，可反复运行刷新。日志：``$script:LogFile``*")
    Set-Content -Path $ReportPath -Value $sb.ToString() -Encoding UTF8
    Write-Host ''
    Ok "Markdown 报告已写入：$ReportPath"
} catch { Warn "报告写入失败：$($_.Exception.Message)" }

$dur = (Get-Date) - $script:StartTime
Write-Host ''
Say ("  总耗时 {0}分{1:D2}秒" -f [int]$dur.TotalMinutes, $dur.Seconds) DarkGray
Write-Host ''
