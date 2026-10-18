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

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build_desktop_runtime.ps1 -Smoke
#>
param(
    [switch]$Smoke,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Py = Join-Path $Root '.venv\Scripts\python.exe'
$Entry = Join-Path $Root 'scripts\desktop_entry.py'
$DistDir = Join-Path $Root 'desktop\runtime'
$WorkDir = Join-Path $Root 'build\pyinstaller'
$SpecDir = Join-Path $Root 'build'
$OutExe = Join-Path $DistDir 'desktop_entry\desktop_entry.exe'

function Write-Stage([string]$Text) {
    Write-Host ''
    Write-Host ('  ' + ('-' * 60))
    Write-Host ('  ' + $Text)
    Write-Host ('  ' + ('-' * 60))
}

Write-Host ''
Write-Host '  ===================================================='
Write-Host '    Forest Gap Detection - 打包 Python 运行时'
Write-Host '  ===================================================='

# ============================================================
#  阶段 1/4：检查环境
# ============================================================
Write-Stage '[1/4] 检查环境'

if (-not (Test-Path $Py)) {
    Write-Host '  [错误] 找不到 .venv\Scripts\python.exe'
    Write-Host '         请先双击 scripts\一键配置环境.bat 配置环境。'
    exit 1
}
Write-Host ('  [已就绪] Python: ' + $Py)

if (-not (Test-Path $Entry)) {
    Write-Host ('  [错误] 找不到入口脚本: ' + $Entry)
    exit 1
}
Write-Host ('  [已就绪] 入口脚本: ' + $Entry)

if (-not $SkipInstall) {
    $pyiVer = & $Py -m PyInstaller --version 2>$null
    if (-not $pyiVer) {
        Write-Host '  [缺失] PyInstaller，正在安装（约 1 分钟）...'
        & $Py -m pip install pyinstaller --no-cache-dir -q
        if ($LASTEXITCODE -ne 0) {
            Write-Host '  [错误] PyInstaller 安装失败（检查网络 / 代理）'
            exit 1
        }
        $pyiVer = & $Py -m PyInstaller --version
    }
    Write-Host ('  [已就绪] PyInstaller ' + $pyiVer)
} else {
    Write-Host '  [跳过] PyInstaller 检查（-SkipInstall）'
}

# ============================================================
#  阶段 2/4：清理旧产物
# ============================================================
Write-Stage '[2/4] 清理旧产物'
foreach ($p in @($DistDir, $WorkDir, (Join-Path $SpecDir 'desktop_entry.spec'))) {
    if (Test-Path $p) {
        Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue
        Write-Host ('  已删除 ' + $p)
    }
}
Write-Host '  清理完成'

# ============================================================
#  阶段 3/4：PyInstaller 打包
# ============================================================
Write-Stage '[3/4] PyInstaller 打包（首次约 3~8 分钟）'
Write-Host ''
Write-Host '  说明：'
Write-Host '    · --onedir 目录模式（不是 --onefile）：启动零解压，不会被杀软拦'
Write-Host '    · --collect-all rasterio/pyproj/shapely：这些包的 Cython .pyd 与'
Write-Host '      数据文件（proj.db / gdal_data）静态分析抓不全，必须显式收集'
Write-Host '    · 单入口：tile_server 与 sidecar 共享同一份动态库'
Write-Host ''

& $Py -m PyInstaller `
    --noconfirm --clean --onedir --name desktop_entry `
    --distpath $DistDir --workpath $WorkDir --specpath $SpecDir `
    --collect-all rasterio `
    --collect-all pyproj `
    --collect-all shapely `
    --collect-submodules scipy.ndimage `
    --collect-submodules scipy.spatial `
    --hidden-import shapefile `
    $Entry

if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host '  [错误] PyInstaller 打包失败，见上方日志。'
    Write-Host '  常见原因：'
    Write-Host '    · 磁盘空间不足（需要 ~1.5 GB 临时空间）'
    Write-Host '    · 杀毒软件拦截写入（把项目目录加入信任）'
    Write-Host '    · 某些包缺 .pyd：补 --collect-all <包名>'
    exit 1
}

if (-not (Test-Path $OutExe)) {
    Write-Host ('  [错误] 打包结束但找不到 ' + $OutExe)
    exit 1
}

$sizeMb = [math]::Round(((Get-ChildItem -Recurse (Split-Path $OutExe) | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Host ''
Write-Host '  打包完成：'
Write-Host ('    目录：' + (Split-Path $OutExe))
Write-Host ('    入口：' + $OutExe)
Write-Host ('    体积：约 ' + $sizeMb + ' MB')

# ============================================================
#  阶段 4/4：冻结态冒烟（可选）
# ============================================================
if ($Smoke) {
    Write-Stage '[4/4] 冻结态冒烟测试（脱离 .venv）'
    Write-Host ''
    Write-Host '  ① 自检（import + EPSG 转换 + GDAL 驱动）：'
    & $OutExe --self-test
    $rc = $LASTEXITCODE
    if ($rc -ne 0) {
        Write-Host ('  [失败] --self-test 退出码 ' + $rc)
        Write-Host '  排查：PROJ_DATA / GDAL_DATA 没定位到 → 看输出里的 proj_dir / gdal_dir'
        exit 1
    }
    Write-Host '  [通过] 自检 OK'
    Write-Host ''
    Write-Host '  ② 瓦片服务 /meta（另起进程，5 秒后自动结束）：'
    $srv = Start-Process -FilePath $OutExe -ArgumentList '--run-tile-server','--port','8799' -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 6
    try {
        $meta = Invoke-RestMethod -Uri 'http://127.0.0.1:8799/meta' -TimeoutSec 20
        Write-Host ('  [通过] /meta ok=' + $meta.ok + '  金字塔=' + $meta.has_overviews + '  中心=' + ($meta.center -join ','))
    } catch {
        Write-Host ('  [失败] /meta 请求失败：' + $_.Exception.Message)
    } finally {
        if ($srv -and -not $srv.HasExited) { Stop-Process -Id $srv.Id -Force }
    }
    Write-Host ''
    Write-Host '  ③ 多进程检测（--workers 2 + ROI + limit 4）：'
    Write-Host '     需要 data 目录里有影像；没有就跳过。'
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
        & $OutExe --params-json $params 2>$null | Select-String '"event": "result"|"event": "error"'
        if ($LASTEXITCODE -eq 0) {
            Write-Host '  [通过] 冻结态多进程检测 exit 0'
        } else {
            Write-Host ('  [失败] 冻结态检测退出码 ' + $LASTEXITCODE)
            exit 1
        }
    } else {
        Write-Host ('  [跳过] 找不到影像 ' + $Img)
    }
}

Write-Host ''
Write-Host '  ===================================================='
Write-Host '   完成。下一步：'
Write-Host '     · 桌面端开发：desktop\启动桌面端.bat'
Write-Host '     · 出安装包：  desktop\构建安装包.bat'
Write-Host '  ===================================================='
Write-Host ''
