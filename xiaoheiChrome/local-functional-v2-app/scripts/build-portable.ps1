param(
  [switch]$SkipZip
)

$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$electronRoot = Join-Path $appRoot 'node_modules\electron\dist'
$electronExe = Join-Path $electronRoot 'electron.exe'
if (-not (Test-Path -LiteralPath $electronExe)) {
  throw '缺少官方 Electron 运行环境。请先在项目目录执行 npm install。'
}

& (Join-Path $PSScriptRoot 'build-native.ps1') -OutputDirectory $appRoot

$distRoot = Join-Path $appRoot 'dist'
$packageRoot = Join-Path $distRoot '小黑多开器-V15-Windows便携版'
$runtimeRoot = Join-Path $packageRoot 'runtime'
$resourceApp = Join-Path $runtimeRoot 'resources\app'
if (Test-Path -LiteralPath $packageRoot) { Remove-Item -LiteralPath $packageRoot -Recurse -Force }
[System.IO.Directory]::CreateDirectory($runtimeRoot) | Out-Null

Copy-Item -Path (Join-Path $electronRoot '*') -Destination $runtimeRoot -Recurse -Force
$copiedElectron = Join-Path $runtimeRoot 'electron.exe'
$mainExe = Join-Path $runtimeRoot '小黑多开器.exe'
Move-Item -LiteralPath $copiedElectron -Destination $mainExe -Force

$brandScript = Join-Path $PSScriptRoot 'brand-exe.mjs'
$brandIcon = Join-Path $appRoot 'assets\logo.ico'
& node $brandScript $mainExe $brandIcon
if ($LASTEXITCODE -ne 0) { throw '主程序图标和版本信息写入失败' }

[System.IO.Directory]::CreateDirectory($resourceApp) | Out-Null
$excludedNames = @('node_modules', 'dist', '.git')
Get-ChildItem -LiteralPath $appRoot -Force | Where-Object { $excludedNames -notcontains $_.Name } | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $resourceApp -Recurse -Force
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $appRoot '..\..'))
foreach ($document in @('README.md', 'DISCLAIMER.md', 'LICENSE')) {
  $source = Join-Path $repoRoot $document
  if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $packageRoot -Force }
}
$notice = Join-Path $appRoot 'THIRD-PARTY-NOTICES.md'
if (Test-Path -LiteralPath $notice) { Copy-Item -LiteralPath $notice -Destination $packageRoot -Force }

$launcher = @'
@echo off
setlocal
for %%F in ("%~dp0runtime\*.exe") do (
  start "" "%%~fF"
  exit /b 0
)
echo Runtime executable was not found.
pause
exit /b 1
'@
[System.IO.File]::WriteAllText((Join-Path $packageRoot 'START.cmd'), $launcher, [System.Text.Encoding]::ASCII)

$instructions = @'
小黑多开器 V15 Windows 便携版

1. 解压完整压缩包，不要只复制单个 EXE。
2. 双击 START.cmd 启动。
3. 本目录 runtime 内含官方 Electron/Chromium 运行环境。
4. 浏览器环境功能仍需要电脑已安装 Google Chrome。
5. 环境数据默认保存在当前 Windows 用户的 AppData\Roaming\browserops-local-sync 中；也可在“本地设置”修改。
6. “API & MCP”默认只监听 127.0.0.1，所有业务请求必须携带本机 API Key。
7. 请勿把 API Key、Cookies、代理密码或浏览器 Profile 上传到 GitHub。

本便携包不包含任何第三方商业浏览器二进制。
'@
[System.IO.File]::WriteAllText((Join-Path $packageRoot '运行说明.txt'), $instructions, (New-Object System.Text.UTF8Encoding($true)))

if (-not $SkipZip) {
  $zip = Join-Path $distRoot '小黑多开器-V15-Windows便携版.zip'
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  Compress-Archive -LiteralPath $packageRoot -DestinationPath $zip -CompressionLevel Optimal
  Write-Host ('便携版压缩包：' + $zip)
}
Write-Host ('便携版目录：' + $packageRoot)
