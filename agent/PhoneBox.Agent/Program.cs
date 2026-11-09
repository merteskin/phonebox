using System.Net;
using System.Text.Json;
using PhoneBox.Agent;

const int Port = 8775; // 8765 is taken by another local app on this PC
const int UsbPort = 8767; // the phone's 127.0.0.1:8765 is reversed here, never to the settings port
string[] SameOrigins = [$"http://127.0.0.1:{Port}", $"http://localhost:{Port}"];

// Install scripts ask where the agent belongs (it differs per OS), then copy it there.
if (args.Contains("--print-install-dir")) { Console.WriteLine(AppPaths.InstallDir); return; }

// Single instance: a second launch opens the running instance's settings page and exits.
// After a restart the previous instance may still be shutting down, so wait for it briefly.
var single = new Mutex(false, @"Local\PhoneBox.Agent");
var waitMs = args.Contains("--restart") ? 15_000 : 0;
bool firstInstance;
try { firstInstance = single.WaitOne(waitMs); }
catch (AbandonedMutexException) { firstInstance = true; }
if (!firstInstance)
{
    try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo($"http://127.0.0.1:{Port}/") { UseShellExecute = true }); } catch { }
    return;
}

AppPaths.EnsureConfig();
var configPath = args.SkipWhile(a => a != "--config").Skip(1).FirstOrDefault() ?? AppPaths.ConfigPath;
var configStore = new ConfigStore(configPath);
configStore.PersistGenerated(); // keep the Wi-Fi token stable across restarts
var lanCfg = configStore.Get().Lan;
System.Security.Cryptography.X509Certificates.X509Certificate2? lanCert = null;
if (lanCfg.Enabled)
{
    try { lanCert = Lan.Certificate(); }
    catch (Exception ex) { Console.Error.WriteLine($"Wi-Fi disabled this run: could not read the TLS certificate ({ex.Message})"); }
}

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory,
});
builder.WebHost.ConfigureKestrel(k =>
{
    k.Listen(IPAddress.Loopback, Port);
    k.Listen(IPAddress.Loopback, UsbPort);
    // Wi-Fi / Tailscale: HTTPS with a pinned self-signed certificate, token required (see Lan.cs).
    if (lanCert is not null) k.Listen(IPAddress.Any, lanCfg.Port, l => l.UseHttps(lanCert));
});
builder.Logging.ClearProviders();
builder.Logging.AddFilter("Microsoft", LogLevel.Warning);
builder.Logging.AddProvider(new FileLoggerProvider());
builder.Logging.AddSimpleConsole(o => { o.SingleLine = true; o.TimestampFormat = "HH:mm:ss "; });
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);

builder.Services.AddSingleton(configStore);
builder.Services.AddSingleton<AudioControl>();
builder.Services.AddSingleton<PushStore>();
builder.Services.AddSingleton<CommandRunner>();
builder.Services.AddSingleton<ApprovalStore>();
AddMonitor<SystemMonitor>(builder.Services);
AddMonitor<MediaMonitor>(builder.Services);
#if WINDOWS
AddMonitor<SpotifyWave>(builder.Services);
#endif
AddMonitor<QuotaMonitor>(builder.Services);
AddMonitor<ProcessMonitor>(builder.Services);
AddMonitor<SessionMonitor>(builder.Services);
AddMonitor<GitHubMonitor>(builder.Services);
AddMonitor<PingMonitor>(builder.Services);
AddMonitor<AdbReverse>(builder.Services);
AddMonitor<UpdateService>(builder.Services);
AddMonitor<RuleEngine>(builder.Services);
builder.Services.AddHostedService<Tray>();

var app = builder.Build();

// The panel in a desktop browser (the layout editor's live preview, /panel/) calls the API as /agent/api/..., the same
// path the phone uses; on the local port that is simply /api/... Routing runs after this, so it sees the new path.
app.Use((ctx, next) =>
{
    if (ctx.Connection.LocalPort == Port && ctx.Request.Path.StartsWithSegments("/agent/api", out var rest))
        ctx.Request.Path = "/api" + rest;
    return next(ctx);
});

// Security:
//  - Local port 8775 listens on 127.0.0.1 only; the Host check blocks DNS rebinding. The phone's USB proxy sends
//    no Origin header; from browsers only the settings page itself (same origin) is accepted (no CSRF).
//  - The optional Wi-Fi port only serves the phone API, only over TLS, and only with the paired token.
app.UseRouting();
app.Use(async (ctx, next) =>
{
    var origin = ctx.Request.Headers.Origin.ToString();
    if (ctx.Connection.LocalPort == UsbPort)
    {
        // Any app on the phone can reach the adb reverse tunnel, so the phone API needs the adb-delivered key here too.
        var p = ctx.Request.Path;
        if (origin != "" || !(Lan.AllowedOverLan(p) || p.StartsWithSegments("/api/pair"))
            || !Lan.Matches(ctx.Request.Headers.Authorization, configStore.Get().Lan.UsbToken!))
        {
            ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
    }
    else if (lanCert is not null && ctx.Connection.LocalPort == lanCfg.Port)
    {
        // The separate webhook key can submit values and notifications. Use headers to keep keys out of URLs.
        var lan = configStore.Get().Lan;
        var authorized = Lan.Matches(ctx.Request.Headers.Authorization, lan.Token!)
            || (Lan.IsWebhookWrite(ctx.Request) && Lan.Matches(ctx.Request.Headers.Authorization, lan.WebhookToken!));
        if (origin != "" || !Lan.AllowedOverLan(ctx.Request.Path) || !authorized)
        {
            ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
    }
    else
    {
        var host = ctx.Request.Host.Host;
        if ((host != "127.0.0.1" && host != "localhost") || (origin != "" && !SameOrigins.Contains(origin)))
        {
            ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
    }
    if (ctx.Request.Path.StartsWithSegments("/api/state") && ctx.Request.Headers.ContainsKey("X-PhoneBox-App"))
        Interlocked.Exchange(ref ApprovalStore.PhoneLastSeen, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    if (ctx.Request.Headers.TryGetValue("X-PhoneBox-App", out var appVersion) && appVersion.ToString().Length is > 0 and < 32)
        UpdateService.AppVersion = appVersion.ToString();
    ctx.Response.Headers.CacheControl = "no-store";
    // only the panel may be framed, and only by the settings page itself (the live preview)
    var panel = ctx.Request.Path.StartsWithSegments("/panel");
    ctx.Response.Headers["X-Frame-Options"] = panel ? "SAMEORIGIN" : "DENY";
    if (panel) ctx.Response.Headers["Content-Security-Policy"] = "frame-ancestors 'self'";
    await next();
});

// ---------------------------------------------------------------- Wi-Fi pairing (local / USB only)
// The phone calls this through the USB tunnel and stores everything it needs to connect over Wi-Fi.
app.MapGet("/api/pair", (ConfigStore cfg) =>
{
    var lan = cfg.Get().Lan;
    if (!lan.Enabled) return Results.Json(new { enabled = false });
    if (lanCert is null) return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
    return Results.Json(new
    {
        enabled = true,
        pc = Environment.MachineName,
        port = lanCfg.Port,
        token = lan.Token,
        fingerprint = Lan.Fingerprint(lanCert),
        hosts = Lan.Addresses(),
    });
});

app.MapGet("/api/lan", (ConfigStore cfg) => Results.Json(new
{
    configured = cfg.Get().Lan.Enabled,
    active = lanCert is not null,
    port = lanCfg.Port,
    restartNeeded = cfg.Get().Lan.Enabled != (lanCert is not null) || (lanCert is not null && cfg.Get().Lan.Port != lanCfg.Port),
    hosts = Lan.Addresses(),
    fingerprint = lanCert is null ? null : Lan.Fingerprint(lanCert),
    publicKeyPin = lanCert is null ? null : Lan.PublicKeyPin(lanCert),
}));

app.MapGet("/api/update", (UpdateService upd, ConfigStore cfg) => Results.Json(new { status = upd.Status(), auto = cfg.Get().Updates.Auto, installed = UpdateService.RunningInstalled }));
app.MapPost("/api/update/check", async (UpdateService upd) => { await upd.CheckAsync(); return Results.Json(upd.Status()); });
app.MapPost("/api/update/apply", (UpdateService upd) => { _ = Task.Run(() => upd.ApplyAsync()); return Results.Accepted(); });

app.MapPost("/api/restart", (IHostApplicationLifetime life) =>
{
    AppRestart.Requested = true;
    life.StopApplication();
    return Results.Ok();
});

// ---------------------------------------------------------------- settings UI (browser)
app.MapGet("/", () =>
{
    using var s = AppPaths.Resource("settings.html")!;
    using var r = new StreamReader(s);
    return Results.Content(r.ReadToEnd(), "text/html; charset=utf-8");
});
// The phone's panel (embedded at build time) for the live preview in the layout editor; local port only.
app.MapGet("/panel/{*file}", (string? file, HttpRequest req) =>
{
    if (string.IsNullOrEmpty(file) && !req.Path.Value!.EndsWith('/')) return Results.Redirect("/panel/" + req.QueryString);
    file = string.IsNullOrEmpty(file) ? "index.html" : file;
    if (file.Contains('/') || file.Contains("..")) return Results.NotFound();
    var type = Path.GetExtension(file) switch
    {
        ".html" => "text/html; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        _ => "application/octet-stream",
    };
    return AppPaths.Resource("www/" + file) is { } s ? Results.Stream(s, type) : Results.NotFound();
});
app.MapGet("/favicon.ico", () => AppPaths.Resource("phonebox.ico") is { } s ? Results.Stream(s, "image/x-icon") : Results.NotFound());

app.MapGet("/api/settings", (ConfigStore cfg) => Results.Text(
    JsonSerializer.Serialize(cfg.Get(), ConfigStore.WriteOpts), "application/json; charset=utf-8"));

app.MapPut("/api/settings", async (HttpRequest req, ConfigStore cfg, ILogger<Program> log) =>
{
    if (req.ContentType?.StartsWith("application/json") != true) return Results.StatusCode(415);
    using var r = new StreamReader(req.Body);
    var err = cfg.Save(await r.ReadToEndAsync());
    if (err is not null) return Results.BadRequest(new { error = err });
    log.LogInformation("settings saved");
    return Results.Ok(new { version = cfg.Version });
});

app.MapPost("/api/shortcuts/test", async (HttpRequest req, ILogger<Program> log) =>
{
    if (req.ContentType?.StartsWith("application/json") != true) return Results.StatusCode(415);
    var sc = await req.ReadFromJsonAsync<PhoneBox.Agent.Shortcut>(new JsonSerializerOptions(JsonSerializerDefaults.Web));
    if (sc is null || string.IsNullOrWhiteSpace(sc.Cmd)) return Results.BadRequest(new { error = "command is empty" });
    var err = Shortcuts.Execute(sc, log);
    return err is null ? Results.Ok() : Results.BadRequest(new { error = err });
});

app.MapGet("/api/info", (AdbReverse adb, ConfigStore cfg) => Results.Json(new
{
    version = AppPaths.Version,
    os = AppPaths.Os,
    configPath = cfg.Path,
    logPath = AppPaths.LogPath,
    adb = AdbReverse.FindAdb(cfg.Get().AdbPath),
    connected = adb.Connected,
    devices = adb.AllDevices,
}));

app.MapPost("/api/phone/open", async (AdbReverse adb) => { await adb.OpenPanelAsync(); return Results.Ok(); });

// Widget types and page templates for the settings page's layout editor.
app.MapGet("/api/catalog", () => Results.Text($"{{\"cols\":{Catalog.Cols},\"rows\":{Catalog.Rows},\"widgets\":{Catalog.WidgetsJson},\"templates\":{Catalog.TemplatesJson}}}",
    "application/json; charset=utf-8"));

// ---------------------------------------------------------------- webhook API: push data and events into the panel
// POST /api/push/{key}       body: JSON or plain text (or ?value=); optional ?ttl=seconds. Shown by "push" widgets.
// DELETE /api/push/{key}     removes a value; GET /api/push lists them.
// POST /api/notify           {"title","text","level":"info|ok|warn|error","vibrate":true,"page":"<page id>","seconds":5} or plain text
// POST /api/goto/{page}      switches the phone to a page (id, or 1-based number)
// POST /api/refresh          refreshes quotas/GitHub now and makes the phone reload its settings and data; ?reload=1 reloads the whole panel
app.MapGet("/api/push", (PushStore push) => Results.Json(new { version = push.Version, items = push.Snapshot() }));
app.MapGet("/api/push/{key}", (string key, PushStore push) => push.Get(key) is { } item ? Results.Json(item) : Results.NotFound());
app.MapMethods("/api/push/{key}", ["POST", "PUT"], async (string key, int? ttl, HttpRequest req, PushStore push) =>
{
    var (data, error) = await PushStore.ReadBody(req);
    if (error is not null) return Results.BadRequest(new { error });
    error = push.Set(key, data!.Value, ttl);
    return error is null ? Results.Json(new { ok = true, key, version = push.Version }) : Results.BadRequest(new { error });
});
app.MapDelete("/api/push/{key}", (string key, PushStore push) => push.Remove(key) ? Results.Ok() : Results.NotFound());
app.MapDelete("/api/push", (PushStore push) => { push.Clear(); return Results.Ok(); });

app.MapPost("/api/notify", async (HttpRequest req, PushStore push) =>
{
    var (data, error) = await PushStore.ReadBody(req);
    if (error is not null) return Results.BadRequest(new { error });
    var d = data!.Value;
    var payload = d.ValueKind == JsonValueKind.Object ? d : JsonSerializer.SerializeToElement(new { text = d.ToString() });
    if (!payload.TryGetProperty("text", out _) && !payload.TryGetProperty("title", out _)) return Results.BadRequest(new { error = "give a text or a title" });
    return Results.Json(push.Emit("notify", payload));
});

app.MapPost("/api/goto/{page}", (string page, PushStore push) => Results.Json(push.Emit("goto", JsonSerializer.SerializeToElement(new { page }))));

app.MapPost("/api/refresh", (bool? reload, PushStore push) =>
{
    Wake.Now();
    return Results.Json(push.Emit(reload == true ? "reload" : "refresh"));
});

// ---------------------------------------------------------------- phone panel API
object State(IServiceProvider sp, long? ev)
{
    var upd = sp.GetRequiredService<UpdateService>();
    var push = sp.GetRequiredService<PushStore>();
    return new
    {
        update = upd.Status() is { } u && (u.AppUpdate || u.AgentUpdate) ? new { latest = u.Latest, app = u.AppUpdate, agent = u.AgentUpdate } : null,
        ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        host = Environment.MachineName,
        cfgVersion = sp.GetRequiredService<ConfigStore>().Version,
        pushVersion = push.Version,
        evSeq = push.Seq,
        events = ev is { } since ? push.Since(since) : [],
        pc = sp.GetRequiredService<SystemMonitor>().Snapshot(),
        media = sp.GetRequiredService<MediaMonitor>().Snapshot(),
        audio = sp.GetRequiredService<AudioControl>().Snapshot(),
        ping = sp.GetRequiredService<PingMonitor>().Snapshot(),
        rules = sp.GetRequiredService<RuleEngine>().Active(),
    };
}

// Settings › Rules › Test: runs a rule's action once (the rule may be unsaved).
app.MapPost("/api/rules/test", (RuleConfig rule, RuleEngine rules) =>
{
    if (!RuleConfig.Actions.Contains(rule.Then)) return Results.BadRequest(new { error = "unknown action" });
    if (string.IsNullOrWhiteSpace(rule.Id)) rule.Id = "test";
    rules.Test(rule);
    return Results.Ok(new { ok = true });
});

app.MapGet("/api/state", (long? ev, HttpContext ctx) => Results.Json(State(ctx.RequestServices, ev)));

// Live stream (server-sent events) for the phone: "state" every second, "event" as soon as one happens, "work" when it
// changes. The Android shell keeps one connection open instead of polling; the panel falls back to polling without it.
app.MapGet("/api/stream", async (HttpContext ctx, PushStore push, SessionMonitor sessions, GitHubMonitor gh, ILogger<Program> log) =>
{
    var ct = ctx.RequestAborted;
    var isPhone = ctx.Request.Headers.ContainsKey("X-PhoneBox-App");
    var via = ctx.Connection.LocalPort == UsbPort ? "USB/ADB" : ctx.Connection.LocalPort == Port ? "local" : "Wi-Fi";
    log.LogInformation("live stream opened ({Who}, {Via})", isPhone ? "phone" : "other client", via);
    ctx.Response.ContentType = "text/event-stream";
    ctx.Response.Headers["X-Accel-Buffering"] = "no";
    var opts = new JsonSerializerOptions(JsonSerializerDefaults.Web);
    async Task Send(string name, object data)
    {
        await ctx.Response.WriteAsync($"event: {name}\ndata: {JsonSerializer.Serialize(data, opts)}\n\n", ct);
        await ctx.Response.Body.FlushAsync(ct);
    }
    using var wake = new SemaphoreSlim(0);
    void OnEmit() { try { wake.Release(); } catch (ObjectDisposedException) { } }
    push.Emitted += OnEmit;
    try
    {
        Func<int[]?>? readWave = null;
#if WINDOWS
        if (ctx.Request.Query["wave"] == "1")
            readWave = ctx.RequestServices.GetRequiredService<SpotifyWave>().Read;
#endif
        var media = ctx.RequestServices.GetRequiredService<MediaMonitor>();
        int[]? sentWave = null;
        var nextWave = 0L;
        var seq = push.Seq;
        var lastWork = "";
        var next = 0L;
        var tick = 0;
        while (!ct.IsCancellationRequested)
        {
            foreach (var e in push.Since(seq)) { await Send("event", e); seq = e.Seq; }
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (now >= next)
            {
                if (isPhone) Interlocked.Exchange(ref ApprovalStore.PhoneLastSeen, now);
                await Send("state", State(ctx.RequestServices, null));
                if (tick++ % 2 == 0)
                {
                    var work = new { sessions = sessions.Snapshot(), github = gh.Snapshot() };
                    var json = JsonSerializer.Serialize(work, opts);
                    if (json != lastWork) { lastWork = json; await Send("work", work); }
                }
                next = now + 1000;
            }
            var wakeAt = next;
            if (readWave is not null && media.Snapshot() is { App: "Spotify", Playing: true })
            {
                if (now >= nextWave)
                {
                    var wave = readWave();
                    if (!ReferenceEquals(wave, sentWave)) await Send("wave", wave ?? []);
                    sentWave = wave;
                    nextWave = now + 80;
                }
                wakeAt = Math.Min(wakeAt, nextWave);
            }
            else if (sentWave is not null)
            {
                await Send("wave", Array.Empty<int>());
                sentWave = null;
            }
            await wake.WaitAsync(TimeSpan.FromMilliseconds(Math.Max(5, wakeAt - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())), ct);
        }
    }
    catch (OperationCanceledException) { }
    catch (IOException) { }
    finally
    {
        push.Emitted -= OnEmit;
        log.LogInformation("live stream closed ({Via})", via);
    }
});

// Claude Code PermissionRequest hook (local only): waits for Allow / Deny from the phone, prints nothing otherwise.
app.MapPost(ClaudeHook.Endpoint, async (HttpRequest req, ConfigStore cfg, ApprovalStore approvals, SessionMonitor sessions) =>
{
    JsonElement input;
    try { input = (await JsonDocument.ParseAsync(req.Body)).RootElement.Clone(); }
    catch (JsonException) { return Results.Text(""); }
    var output = await ClaudeHook.HandleAsync(input, cfg, approvals, sessions, req.HttpContext.RequestAborted);
    return output is null ? Results.Text("") : Results.Json(output);
});
app.MapGet("/api/claude/hook", () => Results.Json(new { installed = ClaudeHook.Installed(), path = ClaudeHook.SettingsPath }));
app.MapPost("/api/claude/hook", (ConfigStore cfg) => ClaudeHook.Configure(true, Port, cfg.Get().Claude.TimeoutSec) is { } err ? Results.BadRequest(new { error = err }) : Results.Ok());
app.MapDelete("/api/claude/hook", (ConfigStore cfg) => ClaudeHook.Configure(false, Port, cfg.Get().Claude.TimeoutSec) is { } err ? Results.BadRequest(new { error = err }) : Results.Ok());

// Permission prompts waiting for the phone (posted by the Claude Code hook, see ClaudeHook.cs).
app.MapGet("/api/approvals", (ApprovalStore a) => Results.Json(new { items = a.Snapshot() }));
app.MapPost("/api/approvals/{id}", (string id, string decision, ApprovalStore a) => a.Decide(id, decision) ? Results.Ok() : Results.NotFound());

// Output of a command widget (the command itself stays here).
app.MapGet("/api/widget/{page}/{widget}", (string page, string widget, bool? force, CommandRunner runner) =>
    runner.Get(page, widget, force == true) is { } r ? Results.Json(r) : Results.NotFound());

app.MapGet("/api/config", (ConfigStore cfg) => cfg.PanelSettings() is { } settings
    ? Results.Json(settings)
    : Results.StatusCode(StatusCodes.Status503ServiceUnavailable));

app.MapGet("/api/art", (MediaMonitor media) =>
    media.Art is { } art ? Results.File(art.Bytes, art.Mime) : Results.NotFound());

app.MapPost("/api/media/{action}", async (string action, long? ms, MediaMonitor media) =>
    await media.Control(action, ms) ? Results.Ok() : Results.BadRequest());

app.MapPost("/api/volume", (int? level, string? op, AudioControl audio) =>
{
    var ok = op switch
    {
        "mute" => audio.ToggleMute(),
        "up" => audio.Step(+5),
        "down" => audio.Step(-5),
        _ when level is { } l => audio.SetVolume(l),
        _ => false,
    };
    return ok ? Results.Json(audio.Snapshot()) : Results.BadRequest();
});

app.MapGet("/api/quotas", (QuotaMonitor q) => Results.Json(new { providers = q.Snapshot() }));

app.MapGet("/api/work", (SessionMonitor s, GitHubMonitor gh) => Results.Json(new
{
    sessions = s.Snapshot(),
    github = gh.Snapshot(),
}));

app.MapGet("/api/procs", (ProcessMonitor procs, int? top) =>
{
    var all = procs.Snapshot();
    return Results.Json(new { total = all.Sum(g => g.Count), groupCount = all.Count, groups = all.Take(Math.Clamp(top ?? 40, 1, 200)) });
});

app.MapGet("/api/procs/icon", (string name, ProcessMonitor procs) =>
    procs.Icon(name) is { } png ? Results.File(png, "image/png") : Results.NotFound());

app.MapGet("/api/procs/detail", (string name, ProcessMonitor procs) => Results.Json(procs.Detail(name)));

// ?name=X ends every instance of X; ?pid=N ends one process together with its children.
app.MapPost("/api/procs/kill", (string? name, int? pid, ProcessMonitor procs, ConfigStore cfg) =>
{
    if (!cfg.Get().AllowKill())
        return Results.Json(new KillResult(0, 0, "Terminating processes is disabled in the settings"), statusCode: 403);
    var r = pid is { } id ? procs.KillPid(id) : procs.Kill(name ?? "");
    return r.Killed > 0 ? Results.Json(r) : Results.Json(r, statusCode: 409);
});

app.MapPost("/api/run/{id}", (string id, ConfigStore cfg, ILogger<Program> log) =>
{
    var result = Shortcuts.Run(cfg.Get(), id, log);
    return result is null ? Results.Ok() : Results.Problem(result);
});

app.Lifetime.ApplicationStarted.Register(() =>
    app.Logger.LogInformation("PhoneBox agent {Version} ready on http://127.0.0.1:{Port} (config: {Path})", AppPaths.Version, Port, configPath));

app.Run();

// Restart requested from the settings page (e.g. Wi-Fi turned on): hand over to a fresh instance.
single.ReleaseMutex();
single.Dispose();
if (AppRestart.Requested && Environment.ProcessPath is { } exe)
    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(exe, "--restart") { UseShellExecute = false, WorkingDirectory = AppContext.BaseDirectory });

static void AddMonitor<T>(IServiceCollection s) where T : class, IHostedService
{
    s.AddSingleton<T>();
    s.AddHostedService(sp => sp.GetRequiredService<T>());
}
