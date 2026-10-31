[CmdletBinding()]
param([string]$Directory = 'dist')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Read the fixed CI-only identity, then remove it from the environment before
# invoking Node or SignTool. Never fall back to generating a replacement key.
try {
    if ([string]::IsNullOrWhiteSpace($env:CI_SIGNING_BUNDLE) -or $env:CI_SIGNING_BUNDLE.Length -gt 48000) { throw 'Missing bundle' }
    $bundle = $env:CI_SIGNING_BUNDLE | ConvertFrom-Json
    if ($bundle.schema -cne 'webmapoverlay.ci-key.v1' -or $bundle.certificateSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $bundle.thumbprint -cnotmatch '^[A-F0-9]{40}$' -or $bundle.password.Length -lt 32) { throw 'Invalid bundle' }
    $pfxBytes = [Convert]::FromBase64String($bundle.pfx)
    $expectedCertificateHash = $bundle.certificateSha256
    $expectedThumbprint = $bundle.thumbprint
} catch { throw 'CI_SIGNING_BUNDLE is missing or invalid. Run the one-time CI signing setup.' }
finally { $env:CI_SIGNING_BUNDLE = $null }

# This entry point is CI-only: never provision a local or YubiKey signing key.
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:GITHUB_REPOSITORY -cne 'sk7z-xyz/WebMapOverlay' -or
    $env:GITHUB_EVENT_NAME -notin @('push', 'workflow_dispatch') -or
    $env:GITHUB_SHA -notmatch '^[a-f0-9]{40}$' -or $env:GITHUB_RUN_ID -notmatch '^[1-9][0-9]*$' -or
    $env:GITHUB_RUN_ATTEMPT -notmatch '^[1-9][0-9]*$') { throw 'Expected an official GitHub-hosted release build.' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$output = [IO.Path]::GetFullPath($Directory)
if ($output -ine [IO.Path]::GetFullPath((Join-Path $root 'dist'))) { throw 'Sign only this checkout dist directory.' }
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Invalid release version.' }
if ($env:GITHUB_EVENT_NAME -eq 'push' -and $env:GITHUB_REF -cne "refs/tags/v$version") { throw 'Release tag does not match package version.' }
if ($env:GITHUB_EVENT_NAME -eq 'workflow_dispatch' -and $env:GITHUB_REF -notin @('refs/heads/main', "refs/tags/v$version")) { throw 'Manual release builds must use main or the version tag.' }
$installer = Join-Path $output "WebMapOverlay-$version-Installer.exe"
$certificateFile = Join-Path $output 'ci-signing.cer'
$manifestFile = Join-Path $output 'ci-signature.json'
if (!(Test-Path -LiteralPath $installer -PathType Leaf) -or
    (Test-Path -LiteralPath $certificateFile) -or (Test-Path -LiteralPath $manifestFile)) { throw 'Missing installer or existing CI signing outputs.' }
& node (Join-Path $PSScriptRoot 'installer-metadata.js') check $output $version
if ($LASTEXITCODE -ne 0) { throw 'Original installer metadata verification failed.' }

$sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
$signTool = Get-ChildItem -LiteralPath $sdk -Directory | Where-Object { $_.Name -match '^10\.0\.[0-9]+\.[0-9]+$' } |
    Sort-Object { [version]$_.Name } -Descending | ForEach-Object { Join-Path $_.FullName 'x64/signtool.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (!$signTool) { throw 'Windows SDK x64 SignTool is required.' }

$certificate = $null
$stored = $false
try {
    # The private key was generated in Actions during the one-time setup. Import
    # the same encrypted PFX on every build, without the Exportable storage flag.
    try {
        $flags = [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::UserKeySet -bor [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::PersistKeySet
        $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($pfxBytes, $bundle.password, $flags)
    } catch { throw 'The fixed CI signing certificate could not be imported.' }
    finally { [Array]::Clear($pfxBytes, 0, $pfxBytes.Length); $bundle = $null }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $actualCertificateHash = [BitConverter]::ToString($hash.ComputeHash($certificate.RawData)).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
    if (!$certificate.HasPrivateKey -or $certificate.Thumbprint -cne $expectedThumbprint -or $actualCertificateHash -cne $expectedCertificateHash -or
        $certificate.NotAfter -lt (Get-Date) -or $certificate.NotBefore -gt (Get-Date)) { throw 'The fixed CI signing identity is invalid or expired.' }
    $privateKey = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
    try {
        $nonExportable = $false
        if ($privateKey -is [Security.Cryptography.RSACng]) { $nonExportable = $privateKey.Key.ExportPolicy -eq [Security.Cryptography.CngExportPolicies]::None }
        elseif ($privateKey -is [Security.Cryptography.RSACryptoServiceProvider]) { $nonExportable = !$privateKey.CspKeyContainerInfo.Exportable }
        if (!$nonExportable -or $privateKey.KeySize -ne 3072) { throw 'Expected a non-exportable RSA-3072 signing key.' }
    } finally { if ($null -ne $privateKey) { $privateKey.Dispose() } }
    $store = [Security.Cryptography.X509Certificates.X509Store]::new('My', 'CurrentUser')
    try { $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite); $store.Add($certificate); $stored = $true }
    finally { $store.Dispose() }
    # Obtain an RFC 3161 timestamp before calculating any distribution hashes.
    # A TSA outage must fail the build rather than publish an untimestamped EXE.
    & $signTool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /sha1 $certificate.Thumbprint /s My $installer
    if ($LASTEXITCODE -ne 0) { throw 'Installer self-signing or timestamping failed.' }
    & (Join-Path $PSScriptRoot 'verify-authenticode.ps1') -Path $installer -Thumbprint $certificate.Thumbprint -RequireTimestamp
    Export-Certificate -Cert $certificate -FilePath $certificateFile -Type CERT | Out-Null
    $signerThumbprint = $certificate.Thumbprint
} finally {
    if ($null -ne $certificate) {
        # Delete this runner's copy before running metadata-generation code.
        if ($stored) { Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -DeleteKey -Force -ErrorAction Stop }
        else {
            $key = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
            try {
                if ($key -is [Security.Cryptography.RSACng]) { $key.Key.Delete() }
                elseif ($key -is [Security.Cryptography.RSACryptoServiceProvider]) { $key.PersistKeyInCsp = $false; $key.Clear() }
            } finally { if ($null -ne $key) { $key.Dispose() } }
        }
        $certificate.Dispose()
    }
}
& node (Join-Path $PSScriptRoot 'installer-metadata.js') refresh $output $version
if ($LASTEXITCODE -ne 0) { throw 'Signed installer metadata generation failed.' }
$manifest = [ordered]@{
        schema = 'webmapoverlay.ci-signature.v1'
        version = $version
        filename = [IO.Path]::GetFileName($installer)
        repository = $env:GITHUB_REPOSITORY
        commit = $env:GITHUB_SHA
        ref = $env:GITHUB_REF
        runId = $env:GITHUB_RUN_ID
        runAttempt = $env:GITHUB_RUN_ATTEMPT
        certificate = 'ci-signing.cer'
        thumbprint = $signerThumbprint
        certificateSha256 = (Get-FileHash -LiteralPath $certificateFile -Algorithm SHA256).Hash.ToLowerInvariant()
        installerSha512 = (Get-FileHash -LiteralPath $installer -Algorithm SHA512).Hash.ToLowerInvariant()
}
[IO.File]::WriteAllText($manifestFile, ($manifest | ConvertTo-Json) + "`n", [Text.UTF8Encoding]::new($false))
Write-Host "Self-signed installer with fixed CI certificate $signerThumbprint."
