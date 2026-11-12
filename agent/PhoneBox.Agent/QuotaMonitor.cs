using System.Globalization;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PhoneBox.Agent;

public sealed record QuotaLimit(string Label, double Percent, long? ResetsAt, long? WindowSec, string Severity);

public sealed record QuotaProvider(string Id, string Name, string Plan, IReadOnlyList<QuotaLimit> Limits,
    string? Extra, long? UpdatedAt, string? Error, string? Source = null);

/// <summary>
/// Collects quota usage of AI subscriptions:
///  - Claude: api.anthropic.com/api/oauth/usage with the OAuth token from ~/.claude/.credentials.json
///    (the endpoint behind Claude Code's /usage command). The agent never refreshes the token itself
///    (that could break Claude Code's session). The desktop app does not update this file, so when the token
///    has expired and Claude is open on this PC, the agent runs "claude auth status", which makes the CLI
///    refresh its own sign-in without sending a model request.
///  - Codex: live account limits through the local Codex app server, with session snapshots as a fallback.
/// </summary>
public sealed partial class QuotaMonitor(ILogger<QuotaMonitor> log) : BackgroundService
{
    private static readonly string Home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(15) };

    private volatile QuotaProvider? _claude;
    private volatile QuotaProvider? _codex;
    private long _nextClaude;
    private long _nextCodex;

    public IReadOnlyList<QuotaProvider> Snapshot() =>
        new[] { _claude, _codex }.Where(p => p is not null).Select(p => p!).ToList();

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("PhoneBox/" + AppPaths.Version);
        while (!ct.IsCancellationRequested)
        {
            if (Environment.TickCount64 >= _nextCodex)
            {
                try { _codex = await ReadLiveCodex(ct) ?? ReadCodex() ?? Fail("codex", "Codex", "No quota data in recent sessions"); }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception ex) { _codex = Fail("codex", "Codex", ex.Message); }
                _nextCodex = Environment.TickCount64 + (_codex.Source == "live" ? 90_000 : 30_000);
            }

            if (Environment.TickCount64 >= _nextClaude)
            {
                // Every 3 minutes when healthy; retry after 1 minute on errors.
                var ok = await RefreshClaude(ct);
                _nextClaude = Environment.TickCount64 + (ok ? 180_000 : 60_000);
            }
            await Wake.Delay(TimeSpan.FromSeconds(30), ct);
        }
    }

    // ------------------------------------------------------------------ Claude
    private async Task<bool> RefreshClaude(CancellationToken ct, bool retried = false)
    {
        string plan = "Claude";
        try
        {
            var path = Path.Combine(Home, ".claude", ".credentials.json");
            string? json = File.Exists(path) ? await File.ReadAllTextAsync(path, ct) : null;
#if !WINDOWS
            // macOS: Claude Code stores the credentials in the login Keychain instead of a file.
            if (json is null && OperatingSystem.IsMacOS()) json = Sh.Run("security", "find-generic-password", "-s", "Claude Code-credentials", "-w")?.Trim();
#endif
            if (string.IsNullOrEmpty(json)) { _claude = Fail("claude", "Claude", "Not signed in to Claude Code"); return false; }

            using var creds = JsonDocument.Parse(json);
            var o = creds.RootElement.GetProperty("claudeAiOauth");
            plan = PlanLabel(Str(o, "subscriptionType"), Str(o, "rateLimitTier"));
            var token = Str(o, "accessToken");
            var expires = o.TryGetProperty("expiresAt", out var e) && e.TryGetInt64(out var ms) ? ms : 0;

            if (string.IsNullOrEmpty(token)) { _claude = Keep(plan, "Not signed in to Claude Code"); return false; }
            if (expires > 0 && expires < DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
            {
                if (!retried && await RefreshSignInViaCli(ct)) return await RefreshClaude(ct, retried: true);
                _claude = Keep(plan, "Token expired; it refreshes while Claude is open on this PC");
                return false;
            }

            using var req = new HttpRequestMessage(HttpMethod.Get, "https://api.anthropic.com/api/oauth/usage");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            req.Headers.Add("anthropic-beta", "oauth-2025-04-20");
            using var res = await _http.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode)
            {
                if (res.StatusCode == System.Net.HttpStatusCode.Unauthorized && !retried && await RefreshSignInViaCli(ct))
                    return await RefreshClaude(ct, retried: true);
                _claude = Keep(plan, $"Could not fetch quota (HTTP {(int)res.StatusCode})");
                return false;
            }
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
            var limits = ParseClaudeLimits(doc.RootElement);
            if (limits.Count == 0) { _claude = Keep(plan, "No quota data"); return false; }
            _claude = new QuotaProvider("claude", "Claude", plan, limits,
                ClaudeExtra(doc.RootElement), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), null, "live");
            return true;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            log.LogDebug("claude quota: {Msg}", ex.Message);
            _claude = Keep(plan, "Could not fetch quota: " + ex.Message);
            return false;
        }
    }

    private long _nextCliRefresh;

    /// <summary>
    /// Lets the Claude Code CLI refresh its expired sign-in ("claude mcp list" refreshes the OAuth token and
    /// writes it back to ~/.claude/.credentials.json without a model request). Only while Claude (desktop app or
    /// CLI) is open on this PC, and at most every 10 minutes.
    /// </summary>
    private async Task<bool> RefreshSignInViaCli(CancellationToken ct)
    {
        if (Environment.TickCount64 < _nextCliRefresh || !ClaudeRunning()) return false;
        _nextCliRefresh = Environment.TickCount64 + 600_000;
        if (ClaudeCli() is not { } cli) { log.LogDebug("claude quota: Claude Code CLI not found"); return false; }
        try
        {
            var start = new ProcessStartInfo(cli)
            {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
                RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = AppPaths.NeutralCwd,
            };
            // "auth status" stopped refreshing the token (CLI 2.1.311 only reports it); "mcp list" still does.
            start.ArgumentList.Add("mcp");
            start.ArgumentList.Add("list");
            using var process = Process.Start(start);
            if (process is null) return false;
            process.StandardInput.Close();
            var drain = Task.WhenAll(process.StandardOutput.ReadToEndAsync(ct), process.StandardError.ReadToEndAsync(ct));
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(60));
            try { await process.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                return false;
            }
            try { await drain; } catch { }
            log.LogInformation("claude quota: asked Claude Code to refresh its expired sign-in (exit {Code})", process.ExitCode);
            return process.ExitCode == 0;
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            log.LogDebug("claude quota: CLI refresh failed: {Message}", ex.Message);
            return false;
        }
    }

    /// <summary>True while the Claude desktop app or a Claude Code CLI is running.</summary>
    private static bool ClaudeRunning()
    {
        var processes = Process.GetProcessesByName("claude");
        try { return processes.Length > 0; }
        finally { foreach (var process in processes) process.Dispose(); }
    }

    /// <summary>
    /// The Claude Code CLI from PATH or the native installer's folder. Never the desktop app's Claude.exe:
    /// starting that with arguments would open the app instead.
    /// </summary>
    private static string? ClaudeCli()
    {
        if (!OperatingSystem.IsWindows()) return "claude";
        var dirs = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Append(Path.Combine(Home, ".local", "bin"));
        foreach (var dir in dirs)
        {
            if (dir.Contains("AnthropicClaude", StringComparison.OrdinalIgnoreCase)) continue;
            foreach (var name in new[] { "claude.exe", "claude.cmd" })
            {
                try { var path = Path.Combine(dir.Trim('"'), name); if (File.Exists(path)) return path; }
                catch (ArgumentException) { }
            }
        }
        return null;
    }

    /// <summary>On errors, keeps the last good values and attaches the error.</summary>
    private QuotaProvider Keep(string plan, string error) =>
        _claude is { Limits.Count: > 0 } prev ? prev with { Plan = plan, Error = error }
            : new QuotaProvider("claude", "Claude", plan, [], null, null, error);

    private static List<QuotaLimit> ParseClaudeLimits(JsonElement root)
    {
        var list = new List<QuotaLimit>();
        if (root.TryGetProperty("limits", out var limits) && limits.ValueKind == JsonValueKind.Array)
        {
            foreach (var l in limits.EnumerateArray())
            {
                if (l.ValueKind != JsonValueKind.Object || Num(l, "percent") is not { } pct) continue;
                var kind = Str(l, "kind");
                var model = l.TryGetProperty("scope", out var sc) && sc.ValueKind == JsonValueKind.Object
                    && sc.TryGetProperty("model", out var m) && m.ValueKind == JsonValueKind.Object ? Str(m, "display_name") : null;
                var (label, window) = kind switch
                {
                    "session" => ("5-hour session", 5 * 3600L),
                    "weekly_all" => ("Weekly", 7 * 86400L),
                    "weekly_scoped" => ($"Weekly · {model ?? "model"}", 7 * 86400L),
                    _ => (kind ?? "Limit", 0L),
                };
                list.Add(new QuotaLimit(label, Math.Clamp(pct, 0, 100), Iso(Str(l, "resets_at")),
                    window > 0 ? window : null, Str(l, "severity") ?? "normal"));
            }
        }
        if (list.Count == 0)
        {
            // Legacy format: five_hour / seven_day
            foreach (var (key, label, window) in new[] { ("five_hour", "5-hour session", 18000L), ("seven_day", "Weekly", 604800L),
                ("seven_day_sonnet", "Weekly · Sonnet", 604800L), ("seven_day_opus", "Weekly · Opus", 604800L) })
                if (root.TryGetProperty(key, out var o) && o.ValueKind == JsonValueKind.Object && Num(o, "utilization") is { } pct)
                    list.Add(new QuotaLimit(label, Math.Clamp(pct, 0, 100), Iso(Str(o, "resets_at")), window, "normal"));
        }
        return list;
    }

    private static string? ClaudeExtra(JsonElement root)
    {
        if (root.TryGetProperty("extra_usage", out var x) && x.ValueKind == JsonValueKind.Object
            && x.TryGetProperty("is_enabled", out var en) && en.ValueKind == JsonValueKind.True)
            return Num(x, "utilization") is { } pct ? $"Extra usage on · {pct:0}%" : "Extra usage on";
        return null;
    }

    private static string PlanLabel(string? sub, string? tier)
    {
        var s = sub switch { "team" => "Team", "max" => "Max", "pro" => "Pro", "enterprise" => "Enterprise", null => "", _ => sub };
        var m = tier is null ? null : MaxTier().Match(tier);
        return m is { Success: true } ? $"{s} · Max {m.Groups[1].Value}".Trim(' ', '·') : (s == "" ? "Claude" : s);
    }

    [GeneratedRegex(@"max_(\d+x)")]
    private static partial Regex MaxTier();

    // ------------------------------------------------------------------ Codex
    private async Task<QuotaProvider?> ReadLiveCodex(CancellationToken ct)
    {
        try
        {
            var start = new ProcessStartInfo(CodexExecutable())
            {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
                RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = AppPaths.NeutralCwd,
            };
            start.ArgumentList.Add("app-server");
            start.ArgumentList.Add("--listen");
            start.ArgumentList.Add("stdio://");
            using var process = Process.Start(start);
            if (process is null) return null;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            var token = timeout.Token;
            var stderr = process.StandardError.BaseStream.CopyToAsync(Stream.Null, token);
            try
            {
                async Task Send(object message)
                {
                    await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(message).AsMemory(), token);
                    await process.StandardInput.FlushAsync(token);
                }
                async Task<JsonElement> Reply(int id)
                {
                    while (await process.StandardOutput.ReadLineAsync(token) is { } line)
                    {
                        using var doc = JsonDocument.Parse(line);
                        var root = doc.RootElement;
                        if (Num(root, "id") != id) continue;
                        return root.TryGetProperty("result", out var result) ? result.Clone() : default;
                    }
                    return default;
                }
                await Send(new { id = 1, method = "initialize", @params = new { clientInfo = new { name = "phonebox", title = "PhoneBox", version = AppPaths.Version } } });
                if ((await Reply(1)).ValueKind != JsonValueKind.Object) return null;
                await Send(new { method = "initialized" });
                await Send(new { id = 2, method = "account/rateLimits/read" });
                var reply = await Reply(2);
                if (reply.ValueKind != JsonValueKind.Object) return null;
                var limits = reply.TryGetProperty("rateLimitsByLimitId", out var buckets) && buckets.ValueKind == JsonValueKind.Object
                    && buckets.TryGetProperty("codex", out var main) && main.ValueKind == JsonValueKind.Object
                    ? main : reply.GetProperty("rateLimits");
                var parsed = CodexLimits(limits, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), live: true);
                return parsed.Limits.Count > 0 ? parsed : null;
            }
            finally
            {
                process.StandardInput.Close();
                if (!process.HasExited)
                {
                    using var shutdown = new CancellationTokenSource(TimeSpan.FromSeconds(1));
                    try { await process.WaitForExitAsync(shutdown.Token); }
                    catch (OperationCanceledException) { if (!process.HasExited) process.Kill(); }
                }
                try { await stderr; } catch (OperationCanceledException) { }
            }
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            log.LogDebug("Codex live quota: {Message}", ex.Message);
            return null;
        }
    }

    private static string CodexExecutable()
    {
        if (!OperatingSystem.IsWindows()) return "codex";
        // A running desktop installation exposes its bundled CLI even when it is absent from PATH.
        var processes = Process.GetProcessesByName("codex");
        try
        {
            foreach (var process in processes)
            {
                try { if (process.MainModule?.FileName is { } path) return path; }
                catch (System.ComponentModel.Win32Exception) { }
                catch (InvalidOperationException) { }
            }
        }
        finally { foreach (var process in processes) process.Dispose(); }
        return "codex.exe";
    }

    private static QuotaProvider? ReadCodex()
    {
        var root = Path.Combine(Home, ".codex", "sessions");
        if (!Directory.Exists(root)) return null;

        // Long-running sessions keep writing into older date folders: scan the last 10 days.
        var files = new List<FileInfo>();
        for (var d = 0; d < 10; d++)
        {
            var day = DateTime.Now.AddDays(-d);
            var dir = Path.Combine(root, day.ToString("yyyy"), day.ToString("MM"), day.ToString("dd"));
            if (Directory.Exists(dir)) files.AddRange(new DirectoryInfo(dir).GetFiles("rollout-*.jsonl"));
        }
        QuotaProvider? newest = null;
        foreach (var f in files.OrderByDescending(f => f.LastWriteTimeUtc).Take(5))
        {
            foreach (var line in RateLimitLines(f.FullName))
            {
                try
                {
                    using var doc = JsonDocument.Parse(line);
                    var row = doc.RootElement;
                    if (!row.TryGetProperty("payload", out var p) || p.ValueKind != JsonValueKind.Object
                        || !p.TryGetProperty("rate_limits", out var rl) || rl.ValueKind != JsonValueKind.Object
                        || Str(rl, "limit_id") is { } id && id != "codex" || Iso(Str(row, "timestamp")) is not { } timestamp) continue;
                    var parsed = CodexLimits(rl, timestamp, live: false);
                    if (parsed.Limits.Count == 0) continue;
                    if (newest is null || parsed.UpdatedAt > newest.UpdatedAt) newest = parsed;
                    break;
                }
                catch (JsonException) { } // The client may still be appending the last record.
            }
        }
        return newest;
    }

    private static QuotaProvider CodexLimits(JsonElement root, long updatedAt, bool live)
    {
        var limits = new List<QuotaLimit>();
        if (root.ValueKind == JsonValueKind.Object)
        {
            foreach (var key in new[] { "primary", "secondary" })
            {
                if (!root.TryGetProperty(key, out var w) || w.ValueKind != JsonValueKind.Object
                    || Num(w, live ? "usedPercent" : "used_percent") is not { } used) continue;
                var mins = (long)(Num(w, live ? "windowDurationMins" : "window_minutes") ?? 0);
                var label = mins switch
                {
                    300 => "5-hour", 10080 => "Weekly", >= 1440 when mins % 1440 == 0 => $"{mins / 1440}-day",
                    >= 60 when mins % 60 == 0 => $"{mins / 60}-hour", > 0 => $"{mins}-minute", _ => key,
                };
                var resetSeconds = Num(w, live ? "resetsAt" : "resets_at");
                var resets = resetSeconds > 0 ? (long)(resetSeconds.Value * 1000)
                    : Num(w, "resets_in_seconds") is { } rs ? updatedAt + (long)(rs * 1000) : (long?)null;
                var pct = Math.Clamp(used, 0, 100);
                limits.Add(new QuotaLimit(label, pct, resets, mins > 0 ? mins * 60 : null, pct >= 95 ? "critical" : pct >= 80 ? "warning" : "normal"));
            }
        }
        var plan = root.ValueKind == JsonValueKind.Object ? Str(root, live ? "planType" : "plan_type") : null;
        return new QuotaProvider("codex", "Codex", string.IsNullOrWhiteSpace(plan) ? "Codex" : char.ToUpperInvariant(plan[0]) + plan[1..],
            limits, null, updatedAt, null, live ? "live" : "session");
    }

    /// <summary>Reads up to 1 MB from the end of a rollout and yields quota records newest first.</summary>
    private static IEnumerable<string> RateLimitLines(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var fileLength = fs.Length;
        var len = Math.Min(fileLength, 1 << 20);
        fs.Seek(-len, SeekOrigin.End);
        var buf = new byte[len];
        fs.ReadExactly(buf);
        var lines = Encoding.UTF8.GetString(buf).Split('\n');
        var first = len == fileLength ? 0 : 1; // the first line may be partial in a truncated read
        for (var i = lines.Length - 1; i >= first; i--)
            if (lines[i].Contains("\"rate_limits\"") && lines[i].Contains("\"primary\"")) yield return lines[i];
    }

    // ------------------------------------------------------------------ helpers
    private static QuotaProvider Fail(string id, string name, string msg) => new(id, name, name, [], null, null, msg);
    private static string? Str(JsonElement e, string p) => e.TryGetProperty(p, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static double? Num(JsonElement e, string p) => e.TryGetProperty(p, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;
    private static long? Iso(string? s) => DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d.ToUnixTimeMilliseconds() : null;
}
