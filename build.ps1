# 打包成可分发的 zip
# 用法：powershell -ExecutionPolicy Bypass -File .\build.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$version = '1.0.0'
try {
  $cfg = Get-Content (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($cfg.version) { $version = $cfg.version }
} catch { }

$node = Join-Path $root 'runtime\node.exe'
if (-not (Test-Path $node)) {
  Write-Host 'runtime/node.exe 不存在，正在准备 Node 运行时...'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\prepare-runtime.ps1')
  if (-not (Test-Path $node)) { throw 'Node 运行时准备失败，无法打包' }
}

$stage = Join-Path $root '_dist\EcomWorkbench'
$dist = Join-Path $root 'dist'
$zip = Join-Path $dist ("EcomWorkbench-v$version.zip")

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
New-Item -ItemType Directory -Force -Path $dist | Out-Null

$items = @('Start.bat', '启动.bat', 'README.md', 'config.json', 'app', 'server', 'skills', 'runtime', 'docs')
foreach ($item in $items) {
  $src = Join-Path $root $item
  if (-not (Test-Path $src)) { continue }
  Copy-Item $src (Join-Path $stage $item) -Recurse -Force
}

# 外部技能目录（config.json 的 extraSkillsDirs）在打包时快照进 skills/，
# 这样发出去的包里技能是全的，而对方电脑上不需要存在那个外部目录。
$extraDirs = @()
if ($cfg -and $cfg.extraSkillsDirs) { $extraDirs = @($cfg.extraSkillsDirs) }
foreach ($rel in $extraDirs) {
  if (-not $rel) { continue }
  $src = Join-Path $root $rel
  if (-not (Test-Path $src)) {
    Write-Host "跳过不存在的技能目录：$rel"
    continue
  }
  $dstSkills = Join-Path $stage 'skills'
  New-Item -ItemType Directory -Force -Path $dstSkills | Out-Null
  # 只复制技能目录，跳过 .git、README、.gitignore 这些仓库文件
  Get-ChildItem $src -Directory -Force | Where-Object { $_.Name -notlike '.*' } | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $dstSkills $_.Name) -Recurse -Force
  }
  Write-Host "已合并外部技能目录：$rel"
}

# 不带个人数据、不带截图、不带测试
foreach ($junk in @('data', 'workspace', 'tests', 'scripts', 'node_modules')) {
  $p = Join-Path $stage $junk
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
Get-ChildItem (Join-Path $stage 'docs') -Filter '*.png' -ErrorAction SilentlyContinue | Remove-Item -Force

# 空目录占位，保证首次启动能创建
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'workspace') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'data') | Out-Null
Set-Content -Path (Join-Path $stage 'workspace\.keep') -Value '' -Encoding UTF8
Set-Content -Path (Join-Path $stage 'data\.keep') -Value '' -Encoding UTF8

if (Test-Path $zip) { Remove-Item $zip -Force }
Write-Host "正在压缩（约 100MB，需要一点时间）..."
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash
$hashFile = Join-Path $dist 'SHA256.txt'
Set-Content -Path $hashFile -Value ("$hash  $(Split-Path $zip -Leaf)") -Encoding ASCII
Write-Host ""
Write-Host "完成：$zip"
Write-Host "SHA256：$hash"
Write-Host "大小：$size MB"
Write-Host ""
Write-Host "分发前检查："
Write-Host "  1. 不要把 data/、workspace/ 里的个人内容打进去"
Write-Host "  2. 不要把 API Key 写进 config.json"
Write-Host "  3. 对方解压后双击 Start.bat 即可"
