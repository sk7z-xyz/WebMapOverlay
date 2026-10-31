# Verify that the packaged app.asar contains no local data or development artifacts.
param()

$projectDirectory = Split-Path -Parent $PSScriptRoot
$asarPath = Join-Path $projectDirectory 'dist\win-unpacked\resources\app.asar'
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
  '\main.js',
  '\signed-updates.js',
  '\update-signature.js',
  '\update-trusted-keys.json',
  '\path-safety.js',
  '\overlay-settings.js',
  '\tracker-status.js',
  '\window-tracker-script.js',
  '\native-bridge.js',
  '\preload.js',
  '\config.html',
  '\keybindings.html',
  '\package.json',
  '\webmap_mini.png'
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
