# 兼容旧入口：实际打包逻辑在 build.ps1
& (Join-Path $PSScriptRoot 'build.ps1')
exit $LASTEXITCODE