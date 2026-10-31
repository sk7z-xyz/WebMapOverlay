# Verify that the packaged app.asar contains no local data or development artifacts.
param([string]$OutputDirectory = 'dist')

$projectDirectory = Split-Path -Parent $PSScriptRoot
$asarPath = Join-Path (Join-Path $projectDirectory $OutputDirectory) 'win-unpacked\resources\app.asar'
$asarCommand = Join-Path $projectDirectory 'node_modules\.bin\asar.cmd'

if (-not (Test-Path -LiteralPath $asarPath)) {
  throw "Packaged app.asar was not found: $asarPath"
}
if (-not (Test-Path -LiteralPath $asarCommand)) {
  throw "The asar inspection command was not found: $asarCommand"
}

$entries = @(& $asarCommand list $asarPath)
if ($LASTEXITCODE -ne 0) {
  throw 'Could not read the app.asar file list.'
}

$requiredEntries = @(
  '\src\main\main.js',
  '\src\main\app-paths.js',
  '\src\main\signed-updates.js',
  '\src\main\update-signature.js',
  '\src\main\update-trusted-keys.json',
  '\src\main\path-safety.js',
  '\src\main\overlay-settings.js',
  '\src\main\tracker-status.js',
  '\src\main\window-tracker-script.js',
  '\src\main\native-bridge.js',
  '\src\preload.js',
  '\src\renderer\config.html',
  '\src\renderer\keybindings.html',
  '\package.json',
  '\assets\webmap_mini.png'
)
foreach ($entry in $requiredEntries) {
  if ($entries -notcontains $entry) {
    throw "A required file is missing from app.asar: $entry"
  }
}

$forbiddenPatterns = @(
  '^\\settings\.json$',
  '^\\user-data(?:\\|$)',
  '^\\OverlayTracker(?:\\|$)',
  '^\\dist(?:\\|$)',
  '^\\scripts(?:\\|$)',
  '^\\build(?:\\|$)',
  '^\\start-overlay\.bat$',
  '\\.pdb$'
)
foreach ($pattern in $forbiddenPatterns) {
  $matchedEntries = @($entries | Where-Object { $_ -match $pattern })
  if ($matchedEntries.Count -gt 0) {
    throw "A forbidden file is included in app.asar: $($matchedEntries -join ', ')"
  }
}

# Ask Electron itself to resolve the moved modules inside app.asar, without opening a window.
$productName = (Get-Content -Raw -LiteralPath (Join-Path $projectDirectory 'package.json') | ConvertFrom-Json).build.productName
$unpackedDirectory = Split-Path -Parent (Split-Path -Parent $asarPath)
$electronExecutable = Join-Path $unpackedDirectory "$productName.exe"
if (-not (Test-Path -LiteralPath $electronExecutable -PathType Leaf)) { throw 'Electron executable is missing.' }
$previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
try {
  $env:ELECTRON_RUN_AS_NODE = '1'
  & $electronExecutable (Join-Path $projectDirectory 'scripts\verify-packaged-paths.js') $asarPath
  if ($LASTEXITCODE -ne 0) { throw 'Packaged application path verification failed.' }
} finally { $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode }

$resourceDirectory = Split-Path -Parent $asarPath
$readmePath = Join-Path $resourceDirectory 'README.txt'
if (-not (Test-Path -LiteralPath $readmePath)) {
  throw "README.txt is missing from the packaged resources: $readmePath"
}
$licensePath = Join-Path $resourceDirectory 'LICENSES.txt'
if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf)) { throw 'LICENSES.txt is missing.' }
$licenseText = Get-Content -Raw -LiteralPath $licensePath
if ($licenseText -notmatch 'WebMapBridge-derived code \(MIT\)' -or $licenseText -notmatch 'MinHook' -or $licenseText -notmatch 'WebMap Overlay \(MIT\)') {
  throw 'Required third-party license notices are missing.'
}
if (-not (Test-Path -LiteralPath (Join-Path $resourceDirectory 'LICENSE') -PathType Leaf)) { throw 'Application LICENSE is missing.' }
$watcherPath = Join-Path $resourceDirectory 'WebMapOverlayWatcher.exe'
if (-not (Test-Path -LiteralPath $watcherPath)) {
  throw "The auto-launch watcher is missing: $watcherPath"
}
$nativeArtifacts = @('WebMapOverlayInjector.exe', 'WebMapOverlayHook.dll', 'WebMapOverlayWriter.dll', 'MinHook-LICENSE.txt')
foreach ($fileName in $nativeArtifacts) {
  $nativePath = Join-Path $resourceDirectory $fileName
  if (-not (Test-Path -LiteralPath $nativePath)) {
    throw "A required native artifact is missing: $nativePath"
  }
}
$removedStandaloneScripts = @(
  'window-tracker.ps1',
  'auto-launch-watcher.ps1',
  'auto-launch-watcher.vbs'
)
foreach ($fileName in $removedStandaloneScripts) {
  $standalonePath = Join-Path $resourceDirectory $fileName
  if (Test-Path -LiteralPath $standalonePath) {
    throw "A removed standalone script is still packaged: $standalonePath"
  }
}

Write-Host "Package verification passed: $($entries.Count) files"
