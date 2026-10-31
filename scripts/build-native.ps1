param(
  [ValidateSet('Release', 'Debug')]
  [string]$Configuration = 'Release',
  [switch]$IncludeLoadOnlyTest,
  [switch]$IncludePassThroughTest,
  [switch]$IncludeStaticRectTest,
  [switch]$IncludeSharedFrameTest,
  [switch]$IncludeSharedFrameDiagnostic
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$nativeDirectory = Join-Path $projectDirectory 'native'
$buildDirectory = Join-Path $nativeDirectory 'build'
$generator = 'Visual Studio 17 2022'

New-Item -ItemType Directory -Force -Path $buildDirectory | Out-Null
& cmake -S $nativeDirectory -B $buildDirectory -G $generator -A x64
if ($LASTEXITCODE -ne 0) { throw 'Native component configuration failed.' }
$targets = @('WebMapOverlayWriter', 'WebMapOverlayHook', 'WebMapOverlayInjector', 'WebMapOverlayNativeLicense')
if ($IncludeLoadOnlyTest) { $targets += 'WebMapOverlayLoadOnly' }
if ($IncludePassThroughTest) { $targets += 'WebMapOverlayPassThrough' }
if ($IncludeStaticRectTest) { $targets += 'WebMapOverlayStaticRect' }
if ($IncludeSharedFrameTest) { $targets += 'WebMapOverlaySharedFrameTest' }
if ($IncludeSharedFrameDiagnostic) { $targets += 'WebMapOverlaySharedFrameDiagnostic' }
& cmake --build $buildDirectory --config $Configuration --target $targets --parallel
if ($LASTEXITCODE -ne 0) { throw 'Native Release build failed.' }

$outputDirectory = Join-Path $nativeDirectory "build\$Configuration"
$required = @('WebMapOverlayWriter.dll', 'WebMapOverlayHook.dll', 'WebMapOverlayInjector.exe', 'MinHook-LICENSE.txt')
if ($IncludeLoadOnlyTest) { $required += 'WebMapOverlayLoadOnly.dll' }
if ($IncludePassThroughTest) { $required += 'WebMapOverlayPassThrough.dll' }
if ($IncludeStaticRectTest) { $required += 'WebMapOverlayStaticRect.dll' }
if ($IncludeSharedFrameTest) { $required += 'WebMapOverlaySharedFrameTest.dll' }
if ($IncludeSharedFrameDiagnostic) { $required += 'WebMapOverlaySharedFrameDiagnostic.dll' }
foreach ($name in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $outputDirectory $name))) {
    throw "Native artifact is missing: $name"
  }
}
Write-Host "Native build passed: $outputDirectory"
