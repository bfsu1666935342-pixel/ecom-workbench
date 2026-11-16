# 下载 Windows 版 Node 运行时到 runtime/node.exe
# 用法：powershell -ExecutionPolicy Bypass -File .\scripts\prepare-runtime.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$target = Join-Path $runtime 'node.exe'

if (Test-Path $target) {
  Write-Host "Node runtime already exists: $target"
  exit 0
}

$version = '24.18.0'
$url = "https://nodejs.org/dist/v$version/node-v$version-win-x64.zip"
$tmpZip = Join-Path $env:TEMP ("node-" + [guid]::NewGuid().ToString('N') + ".zip")
$tmpDir = Join-Path $env:TEMP ("node-" + [guid]::NewGuid().ToString('N'))

try {
  New-Item -ItemType Directory -Force -Path $runtime, $tmpDir | Out-Null
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Write-Host "Downloading Node.js v$version ..."
  Invoke-WebRequest -Uri $url -OutFile $tmpZip -UseBasicParsing
  Expand-Archive -LiteralPath $tmpZip -DestinationPath $tmpDir -Force
  $node = Get-ChildItem -Path $tmpDir -Recurse -Filter 'node.exe' | Select-Object -First 1
  if (-not $node) { throw 'node.exe not found in the downloaded archive' }
  Copy-Item $node.FullName $target -Force
  Write-Host "Node runtime ready: $target"
  & $target --version
} catch {
  Write-Host ""
  Write-Host "Failed to prepare Node runtime: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Download Node.js v$version manually and put node.exe into runtime/."
  exit 1
} finally {
  Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
  Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
