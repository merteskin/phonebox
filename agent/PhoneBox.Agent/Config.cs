using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace PhoneBox.Agent;

public sealed class AgentConfig
{
    public string? DeviceSerial { get; set; }
    public string? AdbPath { get; set; }
    public WeatherConfig Weather { get; set; } = new();
    public NightConfig Night { get; set; } = new();
    public DisplayConfig Display { get; set; } = new();
    public LanConfig Lan { get; set; } = new();
    public UpdateConfig Updates { get; set; } = new();
    public ClaudeConfig Claude { get; set; } = new();
    public List<PageConfig> Pages { get; set; } = [];
    public List<Shortcut> Shortcuts { get; set; } = [];
    public List<RuleConfig> Rules { get; set; } = [];

    /// <summary>The part sent to the phone: commands (shortcut cmd/args/cwd, command widget scripts) are never included.</summary>
    public object ToPublic() => new
    {
        weather = Weather,
        night = Night,
        display = Display,
        pages = Pages.Select(p => new
        {
            p.Id, p.Title, p.Icon, p.Enabled,
            widgets = (p.Widgets ?? []).Select(w => new
            {
                w.Id, w.Type, w.X, w.Y, w.W, w.H,
                options = w.Type == "command" ? w.Options?.Where(o => o.Key != "command").ToDictionary() : w.Options,
            }),
        }),
        shortcuts = Shortcuts.Select(s => new { s.Id, s.Label, s.Icon, s.Color }),
    };

    /// <summary>Ending processes is allowed when an enabled page has a processes widget that allows it.</summary>
    public bool AllowKill() => Pages.Where(p => p.Enabled).SelectMany(p => p.Widgets ?? [])
        .Any(w => w.Type == "processes" && w.Bool("allowKill") != false);
}

public sealed class WeatherConfig
{
    public string City { get; set; } = "Tallinn";
    public double Lat { get; set; } = 59.437;
    public double Lon { get; set; } = 24.745;
}

public sealed class NightConfig
{
    public bool Enabled { get; set; } = true;
    public string Start { get; set; } = "00:30";
    public string End { get; set; } = "07:30";
    public double Brightness { get; set; } = 0.02;
}

public sealed class DisplayConfig
{
    public bool ShowSeconds { get; set; } = true;
    /// <summary>Return to the first page after this many idle seconds; 0 = never.</summary>
    public int IdleReturnSec { get; set; } = 90;
    /// <summary>Vibrate when a session finishes or needs input.</summary>
    public bool Vibrate { get; set; } = true;
    /// <summary>The phone's volume keys switch pages.</summary>
    public bool VolumeKeys { get; set; } = true;
    /// <summary>Screen brightness follows the room (the phone's light sensor).</summary>
    public bool AutoBrightness { get; set; }
    /// <summary>Show the night screen whenever the room is dark, not only at night.</summary>
    public bool NightWhenDark { get; set; }
    /// <summary>A hand near the phone (proximity sensor) wakes the night screen.</summary>
    public bool ProximityWake { get; set; } = true;
    /// <summary>Screen pinning: Home and Recents stay on the panel.</summary>
    public bool Pin { get; set; }
    /// <summary>The panel is the phone's home app: it starts after a reboot and Home returns to it.</summary>
    public bool HomeScreen { get; set; }
}

public sealed class LanConfig
{
    /// <summary>Also accept the phone over Wi-Fi (HTTPS + token, paired over USB). Requires an agent restart.</summary>
    public bool Enabled { get; set; }
    public int Port { get; set; } = 8766;
    /// <summary>Shared secret handed to the phone over USB. Empty = generate a new one (forces re-pairing).</summary>
    public string? Token { get; set; }
    /// <summary>Separate key for the webhook API from other machines (push/notify/goto/refresh only). May appear in URLs.</summary>
    public string? WebhookToken { get; set; }
    /// <summary>Key the phone must send over USB. Delivered only by adb (intent extra), never over HTTP.</summary>
    public string? UsbToken { get; set; }
}

public sealed class UpdateConfig
{
    /// <summary>Install new GitHub releases automatically (phone app over USB, agent in place).</summary>
    public bool Auto { get; set; } = false; // unsigned zips: never auto-install code from GitHub
    public string Repo { get; set; } = "ersinkoc/phonebox";
}

public sealed class ClaudeConfig
{
    /// <summary>Show Claude Code permission prompts on the phone (needs the hook, see Settings › General).</summary>
    public bool PhoneApprovals { get; set; } = true;
    /// <summary>How long the phone may take before Claude Code asks in the terminal instead.</summary>
    public int TimeoutSec { get; set; } = 90;
    /// <summary>Only use the phone when the PC has been idle for a minute (you are away from the keyboard).</summary>
    public bool OnlyWhenAway { get; set; }
}

public sealed class PageConfig
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string Icon { get; set; } = "";
    public bool Enabled { get; set; } = true;
    /// <summary>Widgets on a 12 x 6 grid.</summary>
    public List<WidgetConfig>? Widgets { get; set; }

    /// <summary>Create the page from this template (templates.json) when it has no widgets yet.</summary>
    public string? Template { get; set; }
    /// <summary>Pre-0.6.2 fixed page type (home | ai | work | system | procs | deck); migrated to widgets on load.</summary>
    public string? Type { get; set; }
    /// <summary>Pre-0.6.2 page options; migrated to widget options on load.</summary>
    public Dictionary<string, JsonElement>? Options { get; set; }
}

public sealed class WidgetConfig
{
    public string Id { get; set; } = "";
    public string Type { get; set; } = "";
    public int X { get; set; }
    public int Y { get; set; }
    public int W { get; set; } = 1;
    public int H { get; set; } = 1;
    public Dictionary<string, JsonElement>? Options { get; set; }

    public JsonElement? Opt(string key) => Options is not null && Options.TryGetValue(key, out var v) ? v : null;
    public string? Str(string key) => Opt(key) is { ValueKind: JsonValueKind.String } v ? v.GetString() : null;
    public int? Int(string key) => Opt(key) is { ValueKind: JsonValueKind.Number } v && v.TryGetDouble(out var d) ? (int)d : null;
    public bool? Bool(string key) => Opt(key) is { } v ? v.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => null } : null;
    public void Set(string key, object? value) => (Options ??= [])[key] = JsonSerializer.SerializeToElement(value);
    public WidgetConfig Clone() => new() { Id = Id, Type = Type, X = X, Y = Y, W = W, H = H, Options = Options?.ToDictionary(kv => kv.Key, kv => kv.Value.Clone()) };
}

/// <summary>
/// An automation rule: when something happens on the PC, do something on the panel. With <see cref="WhileActive"/>
/// the effect lasts only as long as the condition (the phone goes back to its page, a pushed value is removed).
/// </summary>
public sealed class RuleConfig
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public bool Enabled { get; set; } = true;
    /// <summary>session-waiting, session-busy, media-playing, process-running, cpu-above, idle, time, push.</summary>
    public string When { get; set; } = "session-waiting";
    /// <summary>App / process names ("zoom|Teams"), a time window ("22:00-07:00") or a push key, depending on <see cref="When"/>.</summary>
    public string? Match { get; set; }
    /// <summary>CPU percent, or idle minutes.</summary>
    public double? Value { get; set; }
    /// <summary>goto, notify or push.</summary>
    public string Then { get; set; } = "goto";
    public string? Page { get; set; }
    public string? Text { get; set; }
    public string? Level { get; set; }
    public string? Key { get; set; }
    public string? PushValue { get; set; }
    public bool WhileActive { get; set; } = true;

    public static readonly string[] Triggers = ["session-waiting", "session-busy", "media-playing", "process-running", "cpu-above", "idle", "time", "push"];
    public static readonly string[] Actions = ["goto", "notify", "push"];
}

public sealed class Shortcut
{
    public string Id { get; set; } = "";
    public string Label { get; set; } = "";
    public string Icon { get; set; } = "";
    public string Color { get; set; } = "#6b7280";
    public string Cmd { get; set; } = "";
    public string? Args { get; set; }
    public string? Cwd { get; set; }
}

/// <summary>Reads/writes config.json; external edits are picked up on the next request.</summary>
public sealed partial class ConfigStore(string path)
{
    /// <summary>Pages a fresh install (or an empty page list) starts with.</summary>
    public static readonly string[] DefaultPages = ["home", "ai", "work", "system", "procs", "deck"];

    private static readonly JsonSerializerOptions ReadOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    public static readonly JsonSerializerOptions WriteOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, // keep emoji and non-ASCII text readable
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly Lock _lock = new();
    private AgentConfig _config = Normalize(new AgentConfig());
    private DateTime _stamp = DateTime.MinValue;

    public string Path => path;

    /// <summary>Version stamp (file write time) so the phone can notice changes.</summary>
    public long Version { get { Get(); return _stamp.Ticks; } }

    public AgentConfig Get()
    {
        lock (_lock)
        {
            try
            {
                var stamp = File.GetLastWriteTimeUtc(path);
                if (stamp != _stamp)
                {
                    _config = Normalize(JsonSerializer.Deserialize<AgentConfig>(File.ReadAllText(path), ReadOpts) ?? new());
                    _stamp = stamp;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"could not read config ({path}): {ex.Message}");
            }
            return _config;
        }
    }

    /// <summary>Validates and saves the settings. Returns an error message, or null on success.</summary>
    public string? Save(string json)
    {
        AgentConfig cfg;
        try { cfg = JsonSerializer.Deserialize<AgentConfig>(json, ReadOpts) ?? throw new JsonException("empty"); }
        catch (JsonException ex) { return "Invalid JSON: " + ex.Message; }

        cfg = Normalize(cfg);
        foreach (var s in cfg.Shortcuts)
            if (string.IsNullOrWhiteSpace(s.Cmd)) return $"Shortcut '{s.Label}' has no command";
        if (cfg.Weather.Lat is < -90 or > 90 || cfg.Weather.Lon is < -180 or > 180) return "Invalid weather location";
        if (!HhMm().IsMatch(cfg.Night.Start) || !HhMm().IsMatch(cfg.Night.End)) return "Night mode times must be in HH:MM format";

        lock (_lock)
        {
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(cfg, WriteOpts));
            if (File.Exists(path)) File.Copy(path, path + ".bak", overwrite: true);
            File.Move(tmp, path, overwrite: true);
            _config = cfg;
            _stamp = File.GetLastWriteTimeUtc(path);
        }
        return null;
    }

    /// <summary>Fills in defaults: builds pages from templates, migrates old pages, generates unique ids.</summary>
    private static AgentConfig Normalize(AgentConfig c)
    {
        c.Weather ??= new();
        c.Night ??= new();
        c.Display ??= new();
        c.Display.IdleReturnSec = Math.Clamp(c.Display.IdleReturnSec, 0, 3600);
        c.Lan ??= new();
        c.Updates ??= new();
        c.Claude ??= new();
        c.Claude.TimeoutSec = Math.Clamp(c.Claude.TimeoutSec, 10, 3600);
        if (string.IsNullOrWhiteSpace(c.Updates.Repo)) c.Updates.Repo = "ersinkoc/phonebox";
        c.Lan.Port = Math.Clamp(c.Lan.Port, 1024, 65535);
        if (string.IsNullOrWhiteSpace(c.Lan.Token)) c.Lan.Token = NewToken();
        if (string.IsNullOrWhiteSpace(c.Lan.WebhookToken)) c.Lan.WebhookToken = NewToken();
        if (string.IsNullOrWhiteSpace(c.Lan.UsbToken)) c.Lan.UsbToken = NewToken();
        c.Night.Brightness = Math.Clamp(c.Night.Brightness, 0.01, 1);

        c.Pages = NormalizePages(c.Pages);

        var used = new HashSet<string>();
        foreach (var s in c.Shortcuts ??= [])
        {
            s.Label = s.Label?.Trim() ?? "";
            var id = string.IsNullOrWhiteSpace(s.Id) ? Slug(s.Label) : Slug(s.Id);
            if (id == "") id = "shortcut";
            var unique = id;
            for (var i = 2; !used.Add(unique); i++) unique = $"{id}-{i}";
            s.Id = unique;
            if (string.IsNullOrWhiteSpace(s.Args)) s.Args = null;
            if (string.IsNullOrWhiteSpace(s.Cwd)) s.Cwd = null;
        }
        var ruleIds = new HashSet<string>();
        c.Rules = (c.Rules ?? []).Where(r => r is not null && RuleConfig.Triggers.Contains(r.When) && RuleConfig.Actions.Contains(r.Then)).Take(50).ToList();
        foreach (var r in c.Rules)
        {
            r.Name = r.Name?.Trim() ?? "";
            var id = Slug(string.IsNullOrWhiteSpace(r.Id) ? (r.Name == "" ? r.When : r.Name) : r.Id);
            if (id == "") id = "rule";
            var unique = id;
            for (var i = 2; !ruleIds.Add(unique); i++) unique = $"{id}-{i}";
            r.Id = unique;
            if (r.Value is { } v) r.Value = Math.Clamp(v, 0, r.When == "idle" ? 1440 : 100);
            r.Level = r.Level is "ok" or "warn" or "error" ? r.Level : "info";
        }
        return c;
    }

    /// <summary>Expands templates, migrates the old fixed pages, keeps widgets on the grid and makes ids unique.</summary>
    private static List<PageConfig> NormalizePages(List<PageConfig>? input)
    {
        var src = input is { Count: > 0 } ? input : DefaultPages.Select(t => new PageConfig { Template = t }).ToList();
        var pages = new List<PageConfig>();
        var pageIds = new HashSet<string>();
        foreach (var p in src)
        {
            if (p is null) continue;
            var tpl = Catalog.Template(p.Template ?? p.Type);
            if ((p.Widgets is null || p.Widgets.Count == 0) && tpl is not null)
            {
                p.Widgets = tpl.Widgets.Select(w => w.Clone()).ToList();
                if (p.Type is not null) MigrateLegacy(p);
            }
            if (string.IsNullOrWhiteSpace(p.Title)) p.Title = tpl?.Title ?? "Page";
            if (string.IsNullOrWhiteSpace(p.Icon)) p.Icon = tpl?.Icon ?? "▫️";
            p.Title = p.Title.Trim();
            var id = Slug(string.IsNullOrWhiteSpace(p.Id) ? (tpl?.Id ?? p.Title) : p.Id);
            if (id == "") id = "page";
            var unique = id;
            for (var i = 2; !pageIds.Add(unique); i++) unique = $"{id}-{i}";
            p.Id = unique;
            p.Template = null;
            p.Type = null;
            p.Options = null;

            var widgetIds = new HashSet<string>();
            var widgets = new List<WidgetConfig>();
            foreach (var w in p.Widgets ?? [])
            {
                if (w is null || !Catalog.IsWidget(w.Type)) continue;
                var (minW, minH) = Catalog.MinSize(w.Type);
                w.W = Math.Clamp(w.W, Math.Min(minW, Catalog.Cols), Catalog.Cols);
                w.H = Math.Clamp(w.H, Math.Min(minH, Catalog.Rows), Catalog.Rows);
                w.X = Math.Clamp(w.X, 0, Catalog.Cols - w.W);
                w.Y = Math.Clamp(w.Y, 0, Catalog.Rows - w.H);
                var wid = Slug(string.IsNullOrWhiteSpace(w.Id) ? w.Type : w.Id);
                if (wid == "") wid = w.Type;
                var wu = wid;
                for (var i = 2; !widgetIds.Add(wu); i++) wu = $"{wid}-{i}";
                w.Id = wu;
                widgets.Add(w);
            }
            p.Widgets = widgets;
            pages.Add(p);
        }
        if (pages.Count > 0 && pages.All(p => !p.Enabled)) pages[0].Enabled = true;
        return pages;
    }

    /// <summary>Carries the options of a pre-0.6.2 fixed page over to the widgets of its template.</summary>
    private static void MigrateLegacy(PageConfig p)
    {
        bool On(string key, bool fallback = true) =>
            p.Options is not null && p.Options.TryGetValue(key, out var v) ? v.ValueKind != JsonValueKind.False : fallback;
        var ws = p.Widgets!;
        WidgetConfig? Find(string type) => ws.FirstOrDefault(w => w.Type == type);
        switch (p.Type)
        {
            case "home":
                var clock = Find("clock");
                clock?.Set("weather", On("weather"));
                var tiles = p.Options?.TryGetValue("tiles", out var t) == true && t.ValueKind == JsonValueKind.Array
                    ? t.EnumerateArray().Select(x => x.GetString()).OfType<string>().ToList()
                    : ["cpu", "gpu", "ram", "net"];
                ws.RemoveAll(w => w.Type == "stat");
                if (!On("media")) { ws.RemoveAll(w => w.Type == "media"); if (clock is not null) clock.W = 12; }
                foreach (var w in ws) w.H = tiles.Count > 0 ? 4 : 6;
                for (var i = 0; i < tiles.Count; i++)
                {
                    var tw = new WidgetConfig { Type = "stat", X = 12 * i / tiles.Count, Y = 4, H = 2 };
                    tw.W = 12 * (i + 1) / tiles.Count - tw.X;
                    tw.Set("metric", tiles[i]);
                    ws.Add(tw);
                }
                break;
            case "ai":
                Find("quotas")?.Set("providers", new[] { "claude", "codex" }.Where(x => On(x)).ToArray());
                break;
            case "work":
                if (!On("sessions")) { ws.RemoveAll(w => w.Type == "sessions"); if (Find("github") is { } g) { g.X = 0; g.W = 12; } }
                else if (!On("github")) { ws.RemoveAll(w => w.Type == "github"); if (Find("sessions") is { } s) s.W = 12; }
                break;
            case "procs":
                Find("processes")?.Set("allowKill", On("allowKill"));
                break;
            case "deck":
                if (p.Options?.TryGetValue("columns", out var cols) == true && cols.TryGetInt32(out var n)) Find("shortcuts")?.Set("columns", n);
                break;
        }
    }

    private static string NewToken() =>
        Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>Makes sure the generated Wi-Fi token is written to disk so it stays stable across restarts.</summary>
    public void PersistGenerated()
    {
        var c = Get();
        try
        {
            var onDisk = JsonSerializer.Deserialize<AgentConfig>(File.ReadAllText(path), ReadOpts);
            if (onDisk?.Lan?.Token == c.Lan.Token && onDisk?.Lan?.WebhookToken == c.Lan.WebhookToken && onDisk?.Lan?.UsbToken == c.Lan.UsbToken) return;
        }
        catch { }
        Save(JsonSerializer.Serialize(c, WriteOpts));
    }

    private static string Slug(string s) => NonSlug().Replace(s.ToLowerInvariant()
        .Replace('ı', 'i').Replace('ğ', 'g').Replace('ü', 'u').Replace('ş', 's').Replace('ö', 'o').Replace('ç', 'c'), "-").Trim('-');

    [GeneratedRegex("[^a-z0-9]+")]
    private static partial Regex NonSlug();

    [GeneratedRegex(@"^([01]\d|2[0-3]):[0-5]\d$")]
    private static partial Regex HhMm();
}
