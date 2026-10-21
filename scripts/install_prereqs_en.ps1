<#
.SYNOPSIS
    Install the Python / Node.js prerequisites for the English build path.

.DESCRIPTION
    The Chinese wizard (scripts\一键配置环境.bat) installs everything but prints
    Chinese only, which shows up as boxes in some consoles. This script covers the
    two tools the build actually needs, with English output, and installs them
    per-user (no administrator rights required).

    Both tools go under a tools root on the data drive:
      Python  -> <root>\python312\python.exe
      Node.js -> <root>\node-v20.18.1-win-x64\node.exe  (portable zip, added to user PATH)

.PARAMETER Tool
    python | node | all

.PARAMETER InstallRoot
    Where to put the tools. Defaults to $env:FGD_TOOLS_ROOT, then D:\forest-gap-tools,
    then %LOCALAPPDATA%\forest-gap-tools.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install_prereqs_en.ps1 -Tool python

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install_prereqs_en.ps1 -Tool all
#>
[CmdletBinding()]
param(
    [ValidateSet('all', 'python', 'node')]
    [string]$Tool = 'all',
    [string]$InstallRoot = ''
)

$ErrorActionPreference = 'Stop'

function Say([string]$Text) { Write-Host $Text }

# ---------------------------------------------------------------- install root
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    if ($env:FGD_TOOLS_ROOT) { $InstallRoot = $env:FGD_TOOLS_ROOT }
    elseif (Test-Path 'D:\') { $InstallRoot = 'D:\forest-gap-tools' }
    else { $InstallRoot = Join-Path $env:LOCALAPPDATA 'forest-gap-tools' }
}
$Downloads = Join-Path $InstallRoot 'downloads'
foreach ($d in @($InstallRoot, $Downloads)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

function Get-File([string]$Url, [string]$OutFile, [string]$Label) {
    Say "  Downloading $Label ..."
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec 900
        $mb = [math]::Round((Get-Item $OutFile).Length / 1MB, 1)
        Say "  [ok] $Label downloaded ($mb MB)"
        return $true
    }
    catch {
        Say "  [ERROR] Download failed: $($_.Exception.Message)"
        Say "          URL: $Url"
        return $false
    }
}

# --------------------------------------------------------------------- Python
function Install-Python {
    $ver = '3.12.9'
    $target = Join-Path $InstallRoot 'python312'
    $exe = Join-Path $target 'python.exe'
    if (Test-Path $exe) {
        Say "  [ok] Python already present: $exe"
        return $true
    }

    $installer = Join-Path $Downloads "python-$ver-amd64.exe"
    $url = "https://www.python.org/ftp/python/$ver/python-$ver-amd64.exe"
    Say "  Installing Python $ver into $target (per-user, no admin needed)"
    if (-not (Get-File $url $installer "Python $ver installer")) { return $false }

    $pyArgs = @(
        '/quiet', 'InstallAllUsers=0', "TargetDir=$target",
        'PrependPath=0', 'Include_launcher=0', 'Include_pip=1', 'Include_test=0'
    )
    Say '  Running the installer, this takes 1-3 minutes ...'
    $proc = Start-Process -FilePath $installer -ArgumentList $pyArgs -Wait -PassThru
    if (-not (Test-Path $exe)) {
        Say "  [ERROR] Installer exited with code $($proc.ExitCode) but $exe is missing."
        Say '          Install manually from https://www.python.org/downloads/ and tick "Add python.exe to PATH".'
        return $false
    }
    $v = ((& $exe -c "import sys;print('.'.join(map(str,sys.version_info[:3])))" 2>&1) -join '').Trim()
    Say "  [ok] Python $v installed"
    return $true
}

# ------------------------------------------------------------------- Node.js
function Install-Node {
    $ver = '20.18.1'
    $zip = Join-Path $Downloads "node-v$ver-win-x64.zip"
    $dir = Join-Path $InstallRoot "node-v$ver-win-x64"
    $exe = Join-Path $dir 'node.exe'
    if (Test-Path $exe) {
        Say "  [ok] Node.js already present: $exe"
        return $true
    }

    $url = "https://nodejs.org/dist/v$ver/node-v$ver-win-x64.zip"
    Say "  Installing Node.js v$ver into $dir (portable zip)"
    if (-not (Get-File $url $zip "Node.js v$ver")) { return $false }

    Say '  Extracting ...'
    Expand-Archive -Path $zip -DestinationPath $InstallRoot -Force
    if (-not (Test-Path $exe)) {
        Say "  [ERROR] Extraction finished but $exe is missing."
        return $false
    }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*$dir*") {
        [Environment]::SetEnvironmentVariable('Path', "$userPath;$dir", 'User')
        Say '  [ok] Added to the user PATH (new terminals will see it)'
    }
    $v = ((& $exe -v 2>&1) -join '').Trim()
    Say "  [ok] Node.js $v installed"
    return $true
}

# ---------------------------------------------------------------------- main
Say ''
Say '  ===================================================='
Say '    Forest Gap Detection - install build prerequisites'
Say '  ===================================================='
Say "  Install root: $InstallRoot"
Say ''

$ok = $true
if ($Tool -eq 'all' -or $Tool -eq 'python') { if (-not (Install-Python)) { $ok = $false } }
if ($Tool -eq 'all' -or $Tool -eq 'node') { if (-not (Install-Node)) { $ok = $false } }

Say ''
if ($ok) {
    Say '  [ok] Prerequisites ready.'
    exit 0
}
Say '  [ERROR] Some prerequisites could not be installed - see the messages above.'
exit 1
