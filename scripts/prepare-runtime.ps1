# 准备便携运行时：
#   1) runtime/node.exe            —— 跑工作台服务
#   2) runtime/python/python.exe   —— 跑带 Python 的技能（周报、类目决策报告）
# 用法：powershell -ExecutionPolicy Bypass -File .\scripts\prepare-runtime.ps1
#       加 -Force 可以强制重新下载
param([switch]$Force)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root 'runtime'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---------- Node ----------
$nodeTarget = Join-Path $runtime 'node.exe'
if ((Test-Path $nodeTarget) -and -not $Force) {
  Write-Host "Node runtime already exists: $nodeTarget"
} else {
  $nodeVersion = '24.18.0'
  $url = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip"
  $tmpZip = Join-Path $env:TEMP ("node-" + [guid]::NewGuid().ToString('N') + ".zip")
  $tmpDir = Join-Path $env:TEMP ("node-" + [guid]::NewGuid().ToString('N'))
  try {
    New-Item -ItemType Directory -Force -Path $runtime, $tmpDir | Out-Null
    Write-Host "Downloading Node.js v$nodeVersion ..."
    Invoke-WebRequest -Uri $url -OutFile $tmpZip -UseBasicParsing
    Expand-Archive -LiteralPath $tmpZip -DestinationPath $tmpDir -Force
    $node = Get-ChildItem -Path $tmpDir -Recurse -Filter 'node.exe' | Select-Object -First 1
    if (-not $node) { throw 'node.exe not found in the downloaded archive' }
    Copy-Item $node.FullName $nodeTarget -Force
    Write-Host "Node runtime ready: $nodeTarget"
    & $nodeTarget --version
  } catch {
    Write-Host ""
    Write-Host "Failed to prepare Node runtime: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Download Node.js v$nodeVersion manually and put node.exe into runtime/."
    exit 1
  } finally {
    Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
    Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ---------- Python（Windows embeddable 包，免安装） ----------
$pyDir = Join-Path $runtime 'python'
$pyTarget = Join-Path $pyDir 'python.exe'
if ((Test-Path $pyTarget) -and -not $Force) {
  Write-Host "Python runtime already exists: $pyTarget"
  & $pyTarget --version
  exit 0
}

$pyVersion = '3.12.8'
$pyUrl = "https://www.python.org/ftp/python/$pyVersion/python-$pyVersion-embed-amd64.zip"
$pyZip = Join-Path $env:TEMP ("py-" + [guid]::NewGuid().ToString('N') + ".zip")
$pyTmp = Join-Path $env:TEMP ("py-" + [guid]::NewGuid().ToString('N'))

try {
  New-Item -ItemType Directory -Force -Path $pyDir, $pyTmp | Out-Null
  Write-Host "Downloading Python $pyVersion (embeddable) ..."
  Invoke-WebRequest -Uri $pyUrl -OutFile $pyZip -UseBasicParsing
  Expand-Archive -LiteralPath $pyZip -DestinationPath $pyTmp -Force
  Copy-Item (Join-Path $pyTmp '*') $pyDir -Recurse -Force

  # embeddable 包默认的 ._pth 里已经有一行 "."，保持原样即可；
  # 这里只确保它存在（没有的话 python 就 import 不到同目录的模块）。
  $pth = Get-ChildItem $pyDir -Filter 'python*._pth' | Select-Object -First 1
  if ($pth) {
    $lines = Get-Content $pth.FullName
    if ($lines -notcontains '.') {
      Set-Content -Path $pth.FullName -Value (@('.') + $lines) -Encoding ASCII
    }
  }
  Write-Host "Python runtime ready: $pyTarget"
  & $pyTarget --version
} catch {
  Write-Host ""
  Write-Host "Failed to prepare Python runtime: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Download python-$pyVersion-embed-amd64.zip manually and unzip into runtime/python/."
  exit 1
} finally {
  Remove-Item $pyZip -Force -ErrorAction SilentlyContinue
  Remove-Item $pyTmp -Recurse -Force -ErrorAction SilentlyContinue
}
