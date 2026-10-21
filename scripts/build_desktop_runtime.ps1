<#
.SYNOPSIS
    打包桌面端的 Python 运行时（PyInstaller 单入口 --onedir）。

.DESCRIPTION
    把 `scripts/desktop_entry.py` 打成一个自带 Python 与全部依赖的目录
    `desktop/runtime/desktop_entry/`，供 Tauri `bundle.resources` 收进安装包。

    ★ 为什么是**单入口**：
      桌面端要拉起两个 Python 进程（tile_server 常驻 + sidecar 按需）。
      如果各打一个 --onedir，rasterio/numpy/scipy/shapely/pyproj 的动态库会被
      复制两遍，包体直接翻倍（~350 MB → ~700 MB）。单入口靠第一个参数分发，
      两个服务共享同一份 `_internal`。

    ★ 为什么严禁 --onefile：
      每次启动都要把数百 MB 解压到 %TEMP%，冷启动 6~10 秒，且极易被杀软拦。

.PARAMETER Smoke
    打包完立刻做冻结态冒烟测试（脱离 .venv 直接调 exe）。

.PARAMETER SkipInstall
    跳过 PyInstaller 的安装检查（离线环境 / 已确认装好时用）。

.PARAMETER Lang
    面向用户的输出语言。传 "en" 走英文分支；留空（默认）走中文，
    行为与历史版本完全一致。

.PARAMETER CheckStale
    只做"运行时是否过期"判定，不打包。供 `_环境准备.bat` 的 ensure_py_runtime 调用。
    退出码：0 = 新鲜（可复用）；1 = 过期（源码比 exe 新，必须重建）；2 = 尚未打包。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build_desktop_runtime.ps1 -Smoke

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build_desktop_runtime.ps1 -Smoke -Lang en

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build_desktop_runtime.ps1 -CheckStale
#>
param(
    [switch]$Smoke,
    [switch]$SkipInstall,
    [string]$Lang = '',
    [switch]$CheckStale
)

$ErrorActionPreference = 'Stop'
$IsEn = ($Lang -eq 'en')
$Root = Split-Path -Parent $PSScriptRoot
$Py = Join-Path $Root '.venv\Scripts\python.exe'
$Entry = Join-Path $Root 'scripts\desktop_entry.py'
$DistDir = Join-Path $Root 'desktop\runtime'
$WorkDir = Join-Path $Root 'build\pyinstaller'
$SpecDir = Join-Path $Root 'build'
$OutExe = Join-Path $DistDir 'desktop_entry\desktop_entry.exe'

# 双语输出助手：$IsEn 为真走英文，否则走中文（默认行为不变）。
function Write-Stage([string]$Cn, [string]$En) {
    $text = if ($IsEn) { $En } else { $Cn }
    Write-Host ''
    Write-Host ('  ' + ('-' * 60))
    Write-Host ('  ' + $text)
    Write-Host ('  ' + ('-' * 60))
}

function Say([string]$Cn, [string]$En) {
    if ($IsEn) { Write-Host $En } else { Write-Host $Cn }
}

# 调用外部命令（python / PyInstaller / exe）时临时把 ErrorActionPreference 降到
# Continue：PowerShell 5.1 会把原生命令写到 stderr 的内容包成 NativeCommandError，
# 在 Stop 下直接变成终止错误 —— 例如「No module named PyInstaller」会把脚本打断，
# 连自动安装都跑不到（这正是历史上运行时一直没被产出的原因）。退出码仍由
# $LASTEXITCODE 显式判断，行为不打折。
function Invoke-Native([scriptblock]$Block) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Block } finally { $ErrorActionPreference = $prev }
}

# ============================================================
#  新鲜度判定（-CheckStale）：不打包，只回答"这个运行时还能用吗"
#  ------------------------------------------------------------
#  为什么需要它：`_环境准备.bat` 的 `ensure_py_runtime` 原来只判
#  "exe 存不存在"，存在就打印「[已就绪]」跳过打包。
#
#  2026-10-21 的代价：编码修复（[E4099] charmap）改的是 **Python 侧**，
#  而 `desktop\runtime` 里的 exe 还是 10-19 冻的旧产物 —— 构建脚本照样
#  说"已就绪"，修复根本没进包。真机验证时 bug 依旧，很容易被误判成
#  "修复无效"，白跑一整轮构建 + 安装。
#
#  判据：任何会被冻进 exe 的源码（scripts\*.py，排除检查/测试脚本）
#  或依赖清单比 exe 新 → 过期。保守但便宜：重建只要 3~8 分钟，
#  而漏掉一次修复要花掉一整天。
# ============================================================
if ($CheckStale) {
    if (-not (Test-Path $OutExe)) {
        Say '  [缺失]   Python 运行时尚未打包' '  [missing] Python runtime bundle not built yet'
        exit 2
    }
    $exeTime = (Get-Item -LiteralPath $OutExe).LastWriteTimeUtc
    $sources = @(
        Get-ChildItem -LiteralPath (Join-Path $Root 'scripts') -Filter '*.py' -File |
            Where-Object { $_.Name -notmatch '^(check_|test_)' }
    )
    $sources += Get-Item -LiteralPath (Join-Path $Root 'requirements.txt')
    $stale = @()
    foreach ($s in $sources) {
        if ($s.LastWriteTimeUtc -gt $exeTime) { $stale += $s.Name }
    }
    if ($stale.Count -gt 0) {
        Say ('  [过期]   Python 运行时比源码旧，需重建：' + ($stale -join '、')) `
            ('  [stale]  Python runtime is older than: ' + ($stale -join ', '))
        exit 1
    }
    Say '  [已就绪] Python 运行时（与源码同步）' '  [ready]  Python runtime (up to date with sources)'
    exit 0
}

Write-Host ''
Write-Host '  ===================================================='
Say '    Forest Gap Detection - 打包 Python 运行时' '    Forest Gap Detection - Bundle Python Runtime'
Write-Host '  ===================================================='

# ============================================================
#  阶段 1/4：检查环境
# ============================================================
Write-Stage '[1/4] 检查环境' '[1/4] Check environment'

if (-not (Test-Path $Py)) {
    Say '  [错误] 找不到 .venv\Scripts\python.exe' '  [ERROR] .venv\Scripts\python.exe not found'
    Say '         请先双击 scripts\一键配置环境.bat 配置环境。' '         Run scripts\一键配置环境.bat first to set up the environment.'
    exit 1
}
Say ('  [已就绪] Python: ' + $Py) ('  [ready]   Python: ' + $Py)

if (-not (Test-Path $Entry)) {
    Say ('  [错误] 找不到入口脚本: ' + $Entry) ('  [ERROR] entry script not found: ' + $Entry)
    exit 1
}
Say ('  [已就绪] 入口脚本: ' + $Entry) ('  [ready]   entry script: ' + $Entry)

if (-not $SkipInstall) {
    $pyiVer = Invoke-Native { & $Py -m PyInstaller --version 2>$null }
    if (-not $pyiVer) {
        Say '  [缺失] PyInstaller，正在安装（约 1 分钟）...' '  [missing] PyInstaller - installing now, about 1 minute...'
        Invoke-Native { & $Py -m pip install pyinstaller --no-cache-dir -q }
        if ($LASTEXITCODE -ne 0) {
            Say '  [错误] PyInstaller 安装失败（检查网络 / 代理）' '  [ERROR] PyInstaller install failed - check network / proxy'
            exit 1
        }
        $pyiVer = Invoke-Native { & $Py -m PyInstaller --version }
    }
    Say ('  [已就绪] PyInstaller ' + $pyiVer) ('  [ready]   PyInstaller ' + $pyiVer)
} else {
    Say '  [跳过] PyInstaller 检查（-SkipInstall）' '  [skip]    PyInstaller check -SkipInstall'
}

# ============================================================
#  阶段 2/4：清理旧产物
# ============================================================
Write-Stage '[2/4] 清理旧产物' '[2/4] Clean previous output'
foreach ($p in @($DistDir, $WorkDir, (Join-Path $SpecDir 'desktop_entry.spec'))) {
    if (Test-Path $p) {
        Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue
        Say ('  已删除 ' + $p) ('  Removed ' + $p)
    }
}
Say '  清理完成' '  Cleanup done'

# ============================================================
#  阶段 3/4：PyInstaller 打包
# ============================================================
Write-Stage '[3/4] PyInstaller 打包（首次约 3~8 分钟）' '[3/4] PyInstaller build - first run about 3-8 minutes'
Write-Host ''
Say '  说明：' '  Notes:'
Say '    · --onedir 目录模式（不是 --onefile）：启动零解压，不会被杀软拦' '    - --onedir mode - not --onefile: no extraction at startup, not flagged by antivirus'
Say '    · --exclude-module torch/cv2/av/transformers/matplotlib/pyogrio：' '    - --exclude-module torch/cv2/av/transformers/matplotlib/pyogrio:'
Say '      数据文件（proj.db / gdal_data）静态分析抓不全，必须显式收集' '      data files - proj.db / gdal_data - are not fully caught by static analysis, so collect them explicitly'
Say '    · 单入口：tile_server 与 sidecar 共享同一份动态库' '    - single entry: tile_server and sidecar share the same dynamic libraries'
Write-Host ''

Invoke-Native {
    & $Py -m PyInstaller `
        --noconfirm --clean --onedir --name desktop_entry `
        --distpath $DistDir --workpath $WorkDir --specpath $SpecDir `
        --collect-all rasterio `
        --collect-all pyproj `
        --collect-all shapely `
        --collect-submodules scipy.ndimage `
        --collect-submodules scipy.spatial `
        --hidden-import shapefile `
        --exclude-module torch `
        --exclude-module torchvision `
        --exclude-module cv2 `
        --exclude-module av `
        --exclude-module transformers `
        --exclude-module matplotlib `
        --exclude-module pyogrio `
        $Entry
}

if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Say '  [错误] PyInstaller 打包失败，见上方日志。' '  [ERROR] PyInstaller build failed; see the log above.'
    Say '  常见原因：' '  Common causes:'
    Say '    · 磁盘空间不足（需要 ~1.5 GB 临时空间）' '    - not enough disk space - about 1.5 GB temp space needed'
    Say '    · 杀毒软件拦截写入（把项目目录加入信任）' '    - antivirus blocking writes - add the project folder to the trust list'
    Say '    · 某些包缺 .pyd：补 --collect-all <包名>' '    - a package is missing .pyd files: add --collect-all <package>'
    exit 1
}

if (-not (Test-Path $OutExe)) {
    Say ('  [错误] 打包结束但找不到 ' + $OutExe) ('  [ERROR] build finished but not found: ' + $OutExe)
    exit 1
}

$sizeMb = [math]::Round(((Get-ChildItem -Recurse (Split-Path $OutExe) | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Host ''
Say '  打包完成：' '  Build complete:'
Say ('    目录：' + (Split-Path $OutExe)) ('    Directory: ' + (Split-Path $OutExe))
Say ('    入口：' + $OutExe) ('    Entry: ' + $OutExe)
Say ('    体积：约 ' + $sizeMb + ' MB') ('    Size: about ' + $sizeMb + ' MB')

# ------------------------------------------------------------
#  恢复 .gitkeep 占位文件
#  ------------------------------------------------------------
#  阶段 2 的清理会 `Remove-Item -Recurse desktop\runtime`，把
#  `desktop\runtime\desktop_entry\.gitkeep` 一并删掉。而它有两个硬用途：
#    ① tauri-build 对 `bundle.resources` 做**存在性硬检查**（目录不在 → 编译期报错）；
#    ② CI 在干净 clone 上跑 `cargo test`，全靠这个文件把目录"撑"出来。
#  2026-10-21 就是这样丢的：打包后 `.gitkeep` 消失，随后 `git add` 把删除
#  一起提交，CI 的编译期检查重新变红 —— 而本地因为目录里有真产物，完全看不出来。
#  所以：打包成功后自动补回，不指望人记得。
$KeepFile = Join-Path $DistDir 'desktop_entry\.gitkeep'
if (-not (Test-Path $KeepFile)) {
    New-Item -ItemType File -Path $KeepFile -Force | Out-Null
    Say '  已恢复占位文件 desktop\runtime\desktop_entry\.gitkeep（CI 依赖它）' `
        '  Restored placeholder desktop\runtime\desktop_entry\.gitkeep (required by CI)'
}

# ============================================================
#  阶段 4/4：冻结态冒烟（可选）
# ============================================================
if ($Smoke) {
    Write-Stage '[4/4] 冻结态冒烟测试（脱离 .venv）' '[4/4] Frozen smoke test - detached from .venv'
    Write-Host ''
    Say '  ① 自检（import + EPSG 转换 + GDAL 驱动）：' '  [1] Self-test: import + EPSG transform + GDAL drivers:'
    Invoke-Native { & $OutExe --self-test }
    $rc = $LASTEXITCODE
    if ($rc -ne 0) {
        Say ('  [失败] --self-test 退出码 ' + $rc) ('  [FAIL] --self-test exit code ' + $rc)
        Say '  排查：PROJ_DATA / GDAL_DATA 没定位到 → 看输出里的 proj_dir / gdal_dir' '  Check: PROJ_DATA / GDAL_DATA not located - see proj_dir / gdal_dir in the output'
        exit 1
    }
    Say '  [通过] 自检 OK' '  [PASS] self-test OK'
    Write-Host ''
    Say '  ② 瓦片服务 /meta（另起进程，5 秒后自动结束）：' '  [2] Tile service /meta - separate process, auto-stops after 5 seconds:'
    $srv = Start-Process -FilePath $OutExe -ArgumentList '--run-tile-server','--port','8799' -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 6
    try {
        $meta = Invoke-RestMethod -Uri 'http://127.0.0.1:8799/meta' -TimeoutSec 20
        Say ('  [通过] /meta ok=' + $meta.ok + '  金字塔=' + $meta.has_overviews + '  中心=' + ($meta.center -join ',')) ('  [PASS] /meta ok=' + $meta.ok + '  overviews=' + $meta.has_overviews + '  center=' + ($meta.center -join ','))
    } catch {
        Say ('  [失败] /meta 请求失败：' + $_.Exception.Message) ('  [FAIL] /meta request failed: ' + $_.Exception.Message)
    } finally {
        if ($srv -and -not $srv.HasExited) { Stop-Process -Id $srv.Id -Force }
    }
    Write-Host ''
    Say '  ③ 多进程检测（--workers 2 + ROI + limit 4）：' '  [3] Multi-process detection: --workers 2 + ROI + limit 4:'
    Say '     需要 data 目录里有影像；没有就跳过。' '     Needs an image under the data directory; skipped if absent.'
    $DataRoot = Join-Path $Root 'drone data'
    $Img = Join-Path $DataRoot 'WGR17-002.tif'
    if (Test-Path $Img) {
        $params = @{
            input = $Img
            job = 'smoke-frozen'
            workers = 2
            limit = 4
            force = $true
        } | ConvertTo-Json -Compress
        Invoke-Native { & $OutExe --params-json $params 2>$null } | Select-String '"event": "result"|"event": "error"'
        if ($LASTEXITCODE -eq 0) {
            Say '  [通过] 冻结态多进程检测 exit 0' '  [PASS] frozen multi-process detection exit 0'
        } else {
            Say ('  [失败] 冻结态检测退出码 ' + $LASTEXITCODE) ('  [FAIL] frozen detection exit code ' + $LASTEXITCODE)
            exit 1
        }
    } else {
        Say ('  [跳过] 找不到影像 ' + $Img) ('  [skip] image not found ' + $Img)
    }
}

Write-Host ''
Write-Host '  ===================================================='
Say '   完成。下一步：' '   Done. Next steps:'
Say '     · 桌面端开发：1. 启动桌面端.bat' '     - Desktop development: 1. 启动桌面端.bat'
Say '     · 出安装包：  2. 构建安装包.bat' '     - Build installer:     2. 构建安装包.bat'
Write-Host '  ===================================================='
Write-Host ''
