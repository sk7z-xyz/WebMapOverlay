param()

$projectDirectory = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectDirectory 'native\watcher\Program.cs'
$outputDirectory = Join-Path $projectDirectory 'build\bin'
$outputPath = Join-Path $outputDirectory 'WebMapOverlayWatcher.exe'
$iconPath = Join-Path $projectDirectory 'assets\webmap_mini.ico'
$compilerCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compilerPath = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $compilerPath) {
  throw 'Windows C# compiler was not found.'
}
if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "Auto-launch watcher source was not found: $sourcePath"
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$arguments = @(
  '/nologo',
  '/target:winexe',
  '/optimize+',
  '/platform:anycpu',
  "/out:$outputPath",
  "/win32icon:$iconPath",
  $sourcePath
)
& $compilerPath @arguments
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outputPath)) {
  throw 'Could not build WebMapOverlayWatcher.exe.'
}

Write-Host "Auto-launch watcher built: $outputPath"
