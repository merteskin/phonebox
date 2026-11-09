using System.Diagnostics;

namespace PhoneBox.Agent;

/// <summary>
/// Keeps the ADB reverse tunnel in place so that 127.0.0.1:8765 on the phone reaches this agent.
/// Opens the panel when a device connects or the agent starts.
/// </summary>
public sealed class AdbReverse(ConfigStore cfg, ILogger<AdbReverse> log) : BackgroundService
{
    public const string PanelActivity = "net.oxog.phonebox.deskpanel/.MainActivity";
    private const string HomeAlias = "net.oxog.phonebox.deskpanel/.HomeAlias";
    private readonly HashSet<string> _homeSet = [];
    private readonly HashSet<string> _opened = [];
    private const string Rule = "tcp:8765";
    private const string Target = "tcp:8767"; // UsbPort in Program.cs

    private string _lastState = "";
    private long _lastReconnect = long.MinValue / 2;
    private volatile string[] _devices = [];
    private volatile string[] _all = [];

    public bool Connected => _devices.Length > 0;
    public string Devices => string.Join(", ", _devices);
    /// <summary>All attached devices, before the deviceSerial filter (for the settings page).</summary>
    public string[] AllDevices => _all;
    public event Action? StateChanged;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await Ensure(ct); }
            catch (OperationCanceledException) { return; }
            catch (Exception ex) { Report($"adb error: {ex.Message}"); }
            await Task.Delay(TimeSpan.FromSeconds(4), ct);
        }
    }

    public async Task OpenPanelAsync()
    {
        var adb = FindAdb(cfg.Get().AdbPath);
        if (adb is null) return;
        foreach (var d in _devices)
        {
            await Adb(adb, $"-s {d} shell input keyevent KEYCODE_WAKEUP", CancellationToken.None);
            await Adb(adb, $"-s {d} shell am start -n {PanelActivity} --es pb_token {cfg.Get().Lan.UsbToken}", CancellationToken.None);
        }
    }

    private async Task Ensure(CancellationToken ct)
    {
        var adb = FindAdb(cfg.Get().AdbPath);
        if (adb is null)
        {
            SetDevices([]);
            _opened.Clear();
            Report("adb not found: " + (OperatingSystem.IsWindows() ? "run 'winget install Google.PlatformTools'"
                : OperatingSystem.IsMacOS() ? "run 'brew install android-platform-tools'" : "run 'sudo apt install adb' (or your distribution's package)") + " or set adbPath in the settings");
            return;
        }

        var serial = cfg.Get().DeviceSerial;
        var rows = (await Adb(adb, "devices", ct))
            .Split('\n').Skip(1)
            .Select(l => l.Trim().Split('\t'))
            .Where(p => p.Length == 2)
            .ToArray();
        // A phone left plugged in while the PC reboots often comes back "offline" and stays so until the cable or
        // USB debugging is toggled. "adb reconnect offline" restores it without touching the phone.
        if (rows.Any(p => p[1] == "offline" && (string.IsNullOrEmpty(serial) || p[0] == serial))
            && Environment.TickCount64 - _lastReconnect > 20_000)
        {
            _lastReconnect = Environment.TickCount64;
            Report("phone offline, reconnecting adb...");
            await Adb(adb, "reconnect offline", ct);
        }
        var devices = rows
            .Where(p => p[1] == "device")
            .Select(p => p[0])
            .ToArray();
        _all = devices;
        devices = devices.Where(s => string.IsNullOrEmpty(serial) || s == serial).ToArray();

        SetDevices(devices);
        _opened.IntersectWith(devices);
        if (devices.Length == 0) { Report("no phone connected, waiting..."); return; }

        foreach (var d in devices)
        {
            var list = await Adb(adb, $"-s {d} reverse --list", ct);
            var hasTunnel = list.Split('\n').Any(line => line.TrimEnd().EndsWith($" {Rule} {Target}", StringComparison.Ordinal));
            if (hasTunnel && _opened.Contains(d)) continue;
            // The rule can survive an agent restart even when the old tunnel no longer forwards traffic.
            if (hasTunnel) await Adb(adb, $"-s {d} reverse --remove {Rule}", ct);
            await Adb(adb, $"-s {d} reverse {Rule} {Target}", ct);
            await Adb(adb, $"-s {d} shell input keyevent KEYCODE_WAKEUP", ct);
            await Adb(adb, $"-s {d} shell am start -n {PanelActivity} --es pb_token {cfg.Get().Lan.UsbToken}", ct);
            _opened.Add(d);
            log.LogInformation("{Device}: adb tunnel ready, panel opened", d);
        }
        // Settings › Display › home screen: the app offers itself as a home app; make it the default one (no root needed).
        if (cfg.Get().Display.HomeScreen)
        {
            foreach (var d in devices.Where(d => !_homeSet.Contains(d)))
            {
                var r = await Adb(adb, $"-s {d} shell cmd package set-home-activity {HomeAlias}", ct);
                if (!r.Contains("Success")) continue; // the app has not enabled its home entry yet; try again shortly
                _homeSet.Add(d);
                log.LogInformation("{Device}: PhoneBox is now the home app", d);
            }
        }
        else _homeSet.Clear();
        Report($"phone connected: {Devices}");
    }

    private void SetDevices(string[] devices)
    {
        var changed = string.Join(",", devices) != string.Join(",", _devices);
        _devices = devices;
        if (changed) StateChanged?.Invoke();
    }

    private void Report(string state)
    {
        if (state == _lastState) return;
        _lastState = state;
        log.LogInformation("{State}", state);
    }

    public static string? FindAdb(string? configured)
    {
        if (!string.IsNullOrEmpty(configured) && File.Exists(configured)) return configured;
        var candidates = new List<string>();
        if (!OperatingSystem.IsWindows())
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(':', StringSplitOptions.RemoveEmptyEntries))
                candidates.Add(Path.Combine(dir, "adb"));
            candidates.AddRange([Path.Combine(home, "Android", "Sdk", "platform-tools", "adb"), Path.Combine(home, "Library", "Android", "sdk", "platform-tools", "adb"),
                "/opt/homebrew/bin/adb", "/usr/local/bin/adb", "/usr/bin/adb", "/usr/lib/android-sdk/platform-tools/adb"]);
            return candidates.FirstOrDefault(File.Exists);
        }
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
            candidates.Add(Path.Combine(dir.Trim(), "adb.exe"));
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        candidates.Add(Path.Combine(local, "Android", "Sdk", "platform-tools", "adb.exe"));
        var winget = Path.Combine(local, "Microsoft", "WinGet", "Packages");
        if (Directory.Exists(winget))
            candidates.AddRange(Directory.GetDirectories(winget, "Google.PlatformTools*")
                .Select(d => Path.Combine(d, "platform-tools", "adb.exe")));
        return candidates.FirstOrDefault(File.Exists);
    }

    private static async Task<string> Adb(string adb, string args, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(adb, args)
        {
            RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true,
            WorkingDirectory = AppPaths.NeutralCwd,
        };
        using var p = Process.Start(psi)!;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        try
        {
            var output = p.StandardOutput.ReadToEndAsync(timeout.Token);
            var error = p.StandardError.ReadToEndAsync(timeout.Token);
            await Task.WhenAll(output, error, p.WaitForExitAsync(timeout.Token));
            if (p.ExitCode != 0) throw new InvalidOperationException($"ADB command exited with code {p.ExitCode}");
            return await output;
        }
        catch (OperationCanceledException)
        {
            try { if (!p.HasExited) p.Kill(); } catch (InvalidOperationException) { }
            ct.ThrowIfCancellationRequested();
            throw new TimeoutException("ADB command timed out");
        }
    }
}
