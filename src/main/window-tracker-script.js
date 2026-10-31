// Stored in app.asar and sent to PowerShell over stdin at runtime.
module.exports = String.raw`Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WindowRectNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int idHook, HookProc callback, IntPtr module, uint threadId);
  [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool PeekMessage(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
  [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG msg);
  [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG msg);
  [DllImport("user32.dll")] private static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint threadId, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public int X, Y; public uint MouseData, Flags, Time; public IntPtr ExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] private struct MSG { public IntPtr Hwnd; public uint Message; public IntPtr WParam, LParam; public uint Time; public int X, Y; }
  private static int _wheelDelta;
  private static int _tiltDelta;
  private static int _altToggleCount;
  private static bool _altDown;
  private static int _altDownTick;
  private static bool _altStartedInStormworks;
  public static int ToggleVk = 0x1D;
  public static int MouseModifierVk = 0x1D;
  public delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
  private static HookProc _callback;
  private static IntPtr _mouseHook;
  private static System.Threading.Thread _mouseThread;
  private static uint _mouseThreadId;
  public static bool IsStormworksActive() {
    var foreground = GetForegroundWindow();
    // Check the actual foreground handle so unrelated dialog windows are not treated as Stormworks.
    if (foreground == IntPtr.Zero) return false;
    uint pid;
    GetWindowThreadProcessId(foreground, out pid);
    try {
      return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.Equals("stormworks64", StringComparison.OrdinalIgnoreCase);
    } catch { }
    return false;
  }
  public static bool IsStormworksRunning() {
    try {
      var processes = System.Diagnostics.Process.GetProcessesByName("stormworks64");
      try { return processes.Length > 0; }
      finally {
        foreach (var process in processes) process.Dispose();
      }
    } catch { }
    return false;
  }
  public static uint FindStormworksProcessId() {
    try {
      var processes = System.Diagnostics.Process.GetProcessesByName("stormworks64");
      try { return processes.Length > 0 ? (uint)processes[0].Id : 0; }
      finally { foreach (var process in processes) process.Dispose(); }
    } catch { return 0; }
  }
  public static IntPtr FindStormworksWindow() {
    var processIds = new System.Collections.Generic.HashSet<uint>();
    try {
      foreach (var process in System.Diagnostics.Process.GetProcessesByName("stormworks64")) processIds.Add((uint)process.Id);
    } catch { return IntPtr.Zero; }
    if (processIds.Count == 0) return IntPtr.Zero;
    IntPtr bestHandle = IntPtr.Zero;
    long bestArea = 0;
    EnumWindows((handle, lParam) => {
      if (!IsWindowVisible(handle)) return true;
      uint processId;
      GetWindowThreadProcessId(handle, out processId);
      if (!processIds.Contains(processId)) return true;
      RECT rect;
      if (!GetWindowRect(handle, out rect)) return true;
      long width = Math.Max(0, rect.Right - rect.Left);
      long height = Math.Max(0, rect.Bottom - rect.Top);
      long area = width * height;
      if (area > bestArea) { bestArea = area; bestHandle = handle; }
      return true;
    }, IntPtr.Zero);
    return bestHandle;
  }
  public static IntPtr InstallMouseHook() {
    HookProc callback = (code, wParam, lParam) => {
      if (code >= 0 && wParam == (IntPtr)0x20A && IsStormworksActive() && MouseModifierVk != 0 && (GetAsyncKeyState(MouseModifierVk) & 0x8000) != 0) {
        var info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
        System.Threading.Interlocked.Add(ref _wheelDelta, (short)(info.MouseData >> 16));
      }
      if (code >= 0 && wParam == (IntPtr)0x20E && IsStormworksActive() && MouseModifierVk != 0 && (GetAsyncKeyState(MouseModifierVk) & 0x8000) != 0) {
        var info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
        System.Threading.Interlocked.Add(ref _tiltDelta, (short)(info.MouseData >> 16));
      }
      return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    };
    _callback = callback;
    return SetWindowsHookEx(14, callback, IntPtr.Zero, 0);
  }
  public static void StartMouseHookThread() {
    if (_mouseThread != null && _mouseThread.IsAlive) return;
    var ready = new System.Threading.ManualResetEventSlim(false);
    _mouseThread = new System.Threading.Thread(() => {
      _mouseThreadId = GetCurrentThreadId();
      _mouseHook = InstallMouseHook();
      ready.Set();
      MSG msg;
      while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {
        TranslateMessage(ref msg);
        DispatchMessage(ref msg);
      }
      if (_mouseHook != IntPtr.Zero) UnhookWindowsHookEx(_mouseHook);
      _mouseHook = IntPtr.Zero;
      _mouseThreadId = 0;
    });
    _mouseThread.IsBackground = true;
    _mouseThread.Start();
    ready.Wait(1000);
  }
  public static void StopMouseHookThread() {
    var thread = _mouseThread;
    var threadId = _mouseThreadId;
    if (thread == null || !thread.IsAlive) return;
    if (threadId != 0) PostThreadMessage(threadId, 0x0012, IntPtr.Zero, IntPtr.Zero);
    thread.Join(1000);
    _mouseThread = null;
  }
  public static IntPtr InstallKeyboardHook() {
    HookProc callback = (code, wParam, lParam) => {
      if (code >= 0) {
        int vk = Marshal.ReadInt32(lParam);
        bool keyDown = wParam == (IntPtr)0x100 || wParam == (IntPtr)0x104;
        bool keyUp = wParam == (IntPtr)0x101 || wParam == (IntPtr)0x105;
        if (ToggleVk != 0 && vk == ToggleVk && keyDown && !_altDown) {
          _altDown = true;
          _altDownTick = Environment.TickCount;
          _altStartedInStormworks = IsStormworksActive();
        } else if (ToggleVk != 0 && vk == ToggleVk && keyUp && _altDown) {
          if (_altStartedInStormworks && Environment.TickCount - _altDownTick < 500) {
            System.Threading.Interlocked.Increment(ref _altToggleCount);
          }
          _altDown = false;
        }
      }
      return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    };
    _keyboardCallback = callback;
    return SetWindowsHookEx(13, callback, IntPtr.Zero, 0);
  }
  private static HookProc _keyboardCallback;
  public static void PumpMessages() {
    MSG msg;
    while (PeekMessage(out msg, IntPtr.Zero, 0, 0, 1)) {
      TranslateMessage(ref msg);
      DispatchMessage(ref msg);
    }
  }
  public static int ConsumeWheelDelta() {
    return System.Threading.Interlocked.Exchange(ref _wheelDelta, 0);
  }
  public static int ConsumeTiltDelta() {
    return System.Threading.Interlocked.Exchange(ref _tiltDelta, 0);
  }
  public static int ConsumeAltToggleCount() {
    return System.Threading.Interlocked.Exchange(ref _altToggleCount, 0);
  }
}
'@

[WindowRectNative]::ToggleVk = $ToggleVk
[WindowRectNative]::MouseModifierVk = $MouseModifierVk

$mouseHookActive = $false
$toggleIsDown = $false
$toggleStartedInStormworks = $false
$toggleDownAt = 0L
$spotIsDown = $false
$reloadIsDown = $false
$nextStatusAt = 0L
$clock = [System.Diagnostics.Stopwatch]::StartNew()

while ($true) {
    $now = $clock.ElapsedMilliseconds
    $modifierDown = $MouseModifierVk -ne 0 -and (([WindowRectNative]::GetAsyncKeyState($MouseModifierVk) -band 0x8000) -ne 0)

    if ($modifierDown -and -not $mouseHookActive) {
      [WindowRectNative]::StartMouseHookThread()
      $mouseHookActive = $true
    } elseif (-not $modifierDown -and $mouseHookActive) {
      [WindowRectNative]::StopMouseHookThread()
      $mouseHookActive = $false
    }

    $toggleDownNow = $ToggleVk -ne 0 -and (([WindowRectNative]::GetAsyncKeyState($ToggleVk) -band 0x8000) -ne 0)
    if ($toggleDownNow -and -not $toggleIsDown) {
      $toggleIsDown = $true
      $toggleDownAt = $now
      $toggleStartedInStormworks = [WindowRectNative]::IsStormworksActive()
    } elseif (-not $toggleDownNow -and $toggleIsDown) {
      if ($toggleStartedInStormworks -and $now - $toggleDownAt -lt 500) { Write-Output 'key:alt-toggle' }
      $toggleIsDown = $false
    }

    $wheelDelta = [WindowRectNative]::ConsumeWheelDelta()
    if ($wheelDelta -ne 0) { Write-Output "wheel:$wheelDelta" }
    $tiltDelta = [WindowRectNative]::ConsumeTiltDelta()
    if ($tiltDelta -ne 0) { Write-Output "tilt:$tiltDelta" }

    if ($now -ge $nextStatusAt) {
      $nextStatusAt = $now + 100
      $active = [WindowRectNative]::IsStormworksActive()
      $stormworksWindow = [WindowRectNative]::FindStormworksWindow()
      if ($stormworksWindow -eq [IntPtr]::Zero) {
        if ([WindowRectNative]::IsStormworksRunning()) { Write-Output "none:$([WindowRectNative]::FindStormworksProcessId())" }
        else { Write-Output 'exited' }
      }
      else {
        $rect = New-Object WindowRectNative+RECT
        $windowPid = [uint32]0
        [WindowRectNative]::GetWindowThreadProcessId($stormworksWindow, [ref]$windowPid) | Out-Null
        if ([WindowRectNative]::GetWindowRect($stormworksWindow, [ref]$rect)) {
          $activeFlag = if ($active) { 1 } else { 0 }
          Write-Output "$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom),$windowPid,$activeFlag"
        } elseif (-not $active) {
          Write-Output "inactive:$windowPid"
        }
      }
      $reloadDownNow = $ReloadVk -ne 0 -and (([WindowRectNative]::GetAsyncKeyState($ReloadVk) -band 0x8000) -ne 0)
      if ($active -and $ReloadVk -ne 0) {
        if ($reloadDownNow -and -not $reloadIsDown) { Write-Output 'key:reload' }
        $reloadIsDown = $reloadDownNow
      } else {
        $reloadIsDown = $false
      }
      $spotDownNow = $SpotVk -ne 0 -and (([WindowRectNative]::GetAsyncKeyState($SpotVk) -band 0x8000) -ne 0)
      if ($active -and $SpotVk -ne 0) {
        if ($spotDownNow -and -not $spotIsDown) { Write-Output 'key:spot' }
        $spotIsDown = $spotDownNow
      } else {
        $spotIsDown = $false
      }
      if ($active -and $ZoomInVk -ne 0 -and (([WindowRectNative]::GetAsyncKeyState($ZoomInVk) -band 0x8000) -ne 0)) { Write-Output 'key:zoom-in' }
      if ($active -and $ZoomOutVk -ne 0 -and (([WindowRectNative]::GetAsyncKeyState($ZoomOutVk) -band 0x8000) -ne 0)) { Write-Output 'key:zoom-out' }
      if ($active -and $SizeIncreaseVk -ne 0 -and (([WindowRectNative]::GetAsyncKeyState($SizeIncreaseVk) -band 0x8000) -ne 0)) { Write-Output 'key:size-increase' }
      if ($active -and $SizeDecreaseVk -ne 0 -and (([WindowRectNative]::GetAsyncKeyState($SizeDecreaseVk) -band 0x8000) -ne 0)) { Write-Output 'key:size-decrease' }
      if ($active -and $OpacityIncreaseVk -ne 0 -and (([WindowRectNative]::GetAsyncKeyState($OpacityIncreaseVk) -band 0x8000) -ne 0)) { Write-Output 'key:opacity-increase' }
      if ($active -and $OpacityDecreaseVk -ne 0 -and (([WindowRectNative]::GetAsyncKeyState($OpacityDecreaseVk) -band 0x8000) -ne 0)) { Write-Output 'key:opacity-decrease' }
    }

    Start-Sleep -Milliseconds 10
}
`;
