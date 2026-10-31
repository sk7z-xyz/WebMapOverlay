[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Fa-f0-9]{40}$')][string]$Thumbprint,
    [switch]$RequireTimestamp
)
$ErrorActionPreference = 'Stop'
$filePath = [IO.Path]::GetFullPath($Path)
$signature = Get-AuthenticodeSignature -LiteralPath $filePath
if ($null -eq $signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint -cne $Thumbprint.ToUpperInvariant() -or
    $signature.SignatureType.ToString() -cne 'Authenticode') { throw 'Embedded signer certificate mismatch.' }
if ($RequireTimestamp -and $null -eq $signature.TimeStamperCertificate) {
    throw 'Embedded Authenticode timestamp is missing.'
}

if (-not ('WebMapOverlayLocal.SignatureCheck' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace WebMapOverlayLocal {
    public static class SignatureCheck {
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
        private struct FileInfo {
            public uint Size;
            [MarshalAs(UnmanagedType.LPWStr)] public string Path;
            public IntPtr Handle;
            public IntPtr KnownSubject;
        }
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
        private struct TrustData {
            public uint Size;
            public IntPtr PolicyCallback;
            public IntPtr SipClient;
            public uint UiChoice;
            public uint RevocationChecks;
            public uint UnionChoice;
            public IntPtr File;
            public uint StateAction;
            public IntPtr StateData;
            public IntPtr Url;
            public uint ProviderFlags;
            public uint UiContext;
            public IntPtr SignatureSettings;
        }
        [DllImport("wintrust.dll", ExactSpelling=true, CharSet=CharSet.Unicode)]
        private static extern uint WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);
        public static uint Verify(string path) {
            var file = new FileInfo { Size = (uint)Marshal.SizeOf(typeof(FileInfo)), Path = path };
            var pointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo)));
            try {
                Marshal.StructureToPtr(file, pointer, false);
                var data = new TrustData {
                    Size = (uint)Marshal.SizeOf(typeof(TrustData)), UiChoice = 2,
                    UnionChoice = 1, File = pointer, ProviderFlags = 0x1000
                }; // No UI, no trust-store changes, cache-only network retrieval.
                var action = new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
                return WinVerifyTrust(new IntPtr(-1), ref action, ref data);
            } finally {
                Marshal.DestroyStructure(pointer, typeof(FileInfo));
                Marshal.FreeHGlobal(pointer);
            }
        }
    }
}
'@
}
$result = [WebMapOverlayLocal.SignatureCheck]::Verify($filePath)
# CERT_E_UNTRUSTEDROOT is expected for this deliberately self-signed leaf.
# Digest/signature/expiry/other failures are rejected; generic UnknownError is never accepted.
if ($result -ne 0 -and $result -ne [uint32]2148204809) {
    throw ('Authenticode verification failed: 0x{0:X8}' -f $result)
}
Write-Host ('Authenticode content verified; trust result 0x{0:X8}, signer {1}' -f $result, $Thumbprint)
