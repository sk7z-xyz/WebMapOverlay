using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;

internal static class Program
{
    private const string MutexName = @"Local\WebMapOverlay.AutoLaunchWatcher";

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length < 1 || string.IsNullOrWhiteSpace(args[0]))
        {
            return 2;
        }

        bool ownsMutex;
        using (var mutex = new Mutex(true, MutexName, out ownsMutex))
        {
            if (!ownsMutex)
            {
                return 0;
            }

            var appPath = Path.GetFullPath(args[0]);
            var appArguments = args.Skip(1).Select(QuoteArgument).ToArray();
            var previousStormworksInstances = new HashSet<string>(StringComparer.Ordinal);
            var ensureOverlayUntilUtc = DateTime.MinValue;
            var lastLaunchAttemptUtc = DateTime.MinValue;

            while (true)
            {
                if (!File.Exists(appPath))
                {
                    return 3;
                }

                var nowUtc = DateTime.UtcNow;
                var currentStormworksInstances = GetStormworksInstances();
                var isStormworksRunning = currentStormworksInstances.Count > 0;
                var newStormworksInstance = currentStormworksInstances.Except(previousStormworksInstances).Any();

                // 終了状態を監視周期の間に取りこぼしても、PIDと開始時刻の変化で再起動を検出する。
                // 旧Overlayの終了処理と重なった場合に備え、15秒間は未起動なら再試行する。
                if (newStormworksInstance)
                {
                    ensureOverlayUntilUtc = nowUtc.AddSeconds(15);
                    lastLaunchAttemptUtc = DateTime.MinValue;
                }

                if (!isStormworksRunning)
                {
                    ensureOverlayUntilUtc = DateTime.MinValue;
                }
                else if (nowUtc <= ensureOverlayUntilUtc
                    && !IsOverlayRunning(appPath)
                    && nowUtc - lastLaunchAttemptUtc >= TimeSpan.FromSeconds(1))
                {
                    StartOverlay(appPath, appArguments);
                    lastLaunchAttemptUtc = nowUtc;
                }

                previousStormworksInstances = currentStormworksInstances;
                Thread.Sleep(500);
            }
        }
    }

    private static HashSet<string> GetStormworksInstances()
    {
        var instances = new HashSet<string>(StringComparer.Ordinal);
        try
        {
            var processes = Process.GetProcessesByName("stormworks64");
            try
            {
                foreach (var process in processes)
                {
                    try
                    {
                        instances.Add(process.Id + ":" + process.StartTime.ToUniversalTime().Ticks);
                    }
                    catch
                    {
                        instances.Add(process.Id.ToString());
                    }
                }
            }
            finally
            {
                foreach (var process in processes)
                {
                    process.Dispose();
                }
            }
        }
        catch
        {
            // 一時的にプロセス一覧を取得できない場合は、次の監視周期で再試行する。
        }
        return instances;
    }

    private static bool IsOverlayRunning(string appPath)
    {
        var targetPath = Path.GetFullPath(appPath);
        var processName = Path.GetFileNameWithoutExtension(targetPath);
        Process[] processes;
        try
        {
            processes = Process.GetProcessesByName(processName);
        }
        catch
        {
            return true;
        }

        try
        {
            foreach (var process in processes)
            {
                try
                {
                    var runningPath = process.MainModule == null ? null : process.MainModule.FileName;
                    if (string.IsNullOrWhiteSpace(runningPath)
                        || string.Equals(Path.GetFullPath(runningPath), targetPath, StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }
                catch
                {
                    // 同名プロセスのパスを参照できない場合は、二重起動を避ける側へ倒す。
                    return true;
                }
            }
            return false;
        }
        finally
        {
            foreach (var process in processes)
            {
                process.Dispose();
            }
        }
    }

    private static void StartOverlay(string appPath, string[] appArguments)
    {
        try
        {
            if (!File.Exists(appPath))
            {
                return;
            }

            Process.Start(new ProcessStartInfo
            {
                FileName = appPath,
                Arguments = string.Join(" ", appArguments),
                WorkingDirectory = Path.GetDirectoryName(appPath) ?? string.Empty,
                UseShellExecute = false,
                CreateNoWindow = true
            });
        }
        catch
        {
            // 次にStormworksが未起動から起動へ変化したとき、再度起動を試みる。
        }
    }

    private static string QuoteArgument(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}
