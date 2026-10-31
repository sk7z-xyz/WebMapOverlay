$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:GITHUB_REPOSITORY -cne 'sk7z-xyz/WebMapOverlay' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or
    $env:GITHUB_REF -cne 'refs/heads/main' -or [string]::IsNullOrWhiteSpace($env:GH_TOKEN)) {
    throw 'Use the main-branch setup workflow with a temporary repository Secrets-write token.'
}
$repository = 'sk7z-xyz/WebMapOverlay'
$secretName = 'CI_SIGNING_BUNDLE'
$existing = & gh secret list --repo $repository --json name
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect repository secrets. Check the temporary token permission.' }
$names = @(($existing -join "`n" | ConvertFrom-Json) | ForEach-Object { $_.name })
if ($names -contains $secretName) { throw 'The CI signing identity already exists. Refusing to replace or rotate it.' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$output = Join-Path $root 'ci-signing-public'
if (Test-Path -LiteralPath $output) { throw 'Public output directory already exists.' }
New-Item -ItemType Directory -Path $output | Out-Null
$certificate = $null
$pfx = $null
$bundle = $null
try {
    # Exportability is needed only here to move the identity directly into
    # encrypted GitHub Secrets. No private-key artifact or local file is created.
    $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=sk7z-xyz WebMapOverlay CI' `
        -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable `
        -Provider 'Microsoft Software Key Storage Provider' -CertStoreLocation Cert:\CurrentUser\My `
        -NotAfter (Get-Date).AddYears(5)
    $random = [byte[]]::new(48)
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($random) } finally { $rng.Dispose() }
    $password = [Convert]::ToBase64String($random)
    [Array]::Clear($random, 0, $random.Length)
    $pfx = $certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pkcs12, $password)
    $certificatePath = Join-Path $output 'ci-signing.cer'
    Export-Certificate -Cert $certificate -FilePath $certificatePath -Type CERT | Out-Null
    $publicHash = (Get-FileHash -LiteralPath $certificatePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $public = [ordered]@{schema = 'webmapoverlay.ci-public.v1'; repository = $repository;
        thumbprint = $certificate.Thumbprint; certificateSha256 = $publicHash; notAfter = $certificate.NotAfter.ToUniversalTime().ToString('o')}
    [IO.File]::WriteAllText((Join-Path $output 'ci-signing-public.json'), ($public | ConvertTo-Json) + "`n", [Text.UTF8Encoding]::new($false))
    $bundle = [ordered]@{schema = 'webmapoverlay.ci-key.v1'; pfx = [Convert]::ToBase64String($pfx);
        password = $password; thumbprint = $certificate.Thumbprint; certificateSha256 = $publicHash} | ConvertTo-Json -Compress
    if ($bundle.Length -gt 48000) { throw 'Signing bundle exceeds the GitHub Secret size limit.' }

    # Transfer the value through stdin, never a command-line argument, file,
    # workflow output or log. gh encrypts the secret with the repository key.
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = (Get-Command gh -ErrorAction Stop).Source
    $start.Arguments = "secret set $secretName --repo $repository"
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    $started = $false
    try {
        $started = $process.Start()
        if (!$started) { throw 'Cannot start encrypted secret registration.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.Write($bundle)
        $process.StandardInput.Close()
        if (!$process.WaitForExit(60000) -or $process.ExitCode -ne 0) { throw 'Encrypted secret registration failed; the signing identity was not confirmed.' }
    } finally {
        if ($started -and !$process.HasExited) { $process.Kill() }
        $process.Dispose()
    }
    & gh secret delete CI_SIGNING_SETUP_TOKEN --repo $repository
    if ($LASTEXITCODE -ne 0) { throw 'The signing identity was saved, but the temporary setup secret could not be removed. Remove CI_SIGNING_SETUP_TOKEN manually; do not recreate the signing key.' }
    Write-Host "Fixed CI identity saved in GitHub Secrets. Public certificate SHA-256: $publicHash"
} finally {
    $bundle = $null
    $password = $null
    if ($null -ne $pfx) { [Array]::Clear($pfx, 0, $pfx.Length) }
    if ($null -ne $certificate) {
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -DeleteKey -Force -ErrorAction Stop
        $certificate.Dispose()
    }
    $env:GH_TOKEN = $null
}
