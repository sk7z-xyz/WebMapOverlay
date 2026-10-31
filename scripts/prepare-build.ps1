# 開発用 Overlay が Electron 実行ファイルを掴んだままビルドするのを防ぐ。
param()
$ProgressPreference = 'SilentlyContinue'

$projectDirectory = Split-Path -Parent $PSScriptRoot
$watcherBuildScript = Join-Path $PSScriptRoot 'build-auto-launch-watcher.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watcherBuildScript
if ($LASTEXITCODE -ne 0) {
  throw 'Could not build the auto-launch watcher.'
}

$nativeBuildScript = Join-Path $PSScriptRoot 'build-native.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $nativeBuildScript -Configuration Release
if ($LASTEXITCODE -ne 0) {
  throw 'Could not build the native DLL components.'
}
