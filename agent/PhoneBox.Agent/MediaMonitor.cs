using Windows.Media.Control;

namespace PhoneBox.Agent;

/// <summary>Watches and controls the current Windows media session (Spotify, browsers, ...).</summary>
public sealed class MediaMonitor(ILogger<MediaMonitor> log) : BackgroundService
{
    private GlobalSystemMediaTransportControlsSessionManager? _mgr;
    private volatile MediaSnapshot? _snap;
    private string _trackKey = "";
    private int _artId;
    private long _nextArtTry;

    public AlbumArt? Art { get; private set; }
    public MediaSnapshot? Snapshot() => _snap;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                _mgr ??= await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
                await Poll();
            }
            catch (Exception ex)
            {
                log.LogDebug("media: {Msg}", ex.Message);
                _snap = null;
            }
            await Task.Delay(1000, ct);
        }
    }

    private async Task Poll()
    {
        var s = _mgr!.GetCurrentSession();
        if (s is null) { _snap = null; return; }

        var props = await s.TryGetMediaPropertiesAsync();
        var pb = s.GetPlaybackInfo();
        var tl = s.GetTimelineProperties();
        var playing = pb.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;

        var key = $"{s.SourceAppUserModelId}|{props.Title}|{props.Artist}";
        if (key != _trackKey)
        {
            _trackKey = key;
            _nextArtTry = 0;
            Art = null;
        }
        // Spotify sometimes delivers the cover art a few seconds late; retry a few times.
        if (Art is null && Environment.TickCount64 >= _nextArtTry && props.Thumbnail is { } thumb)
        {
            _nextArtTry = Environment.TickCount64 + 2500;
            try
            {
                using var stream = await thumb.OpenReadAsync();
                using var ms = new MemoryStream();
                await stream.AsStreamForRead().CopyToAsync(ms);
                if (ms.Length > 0)
                {
                    Art = new AlbumArt(ms.ToArray(), string.IsNullOrEmpty(stream.ContentType) ? "image/png" : stream.ContentType);
                    _artId++;
                }
            }
            catch (Exception ex) { log.LogDebug("cover art: {Msg}", ex.Message); }
        }

        var pos = tl.Position;
        if (playing && tl.LastUpdatedTime.Year > 2000)
            pos += DateTimeOffset.Now - tl.LastUpdatedTime;
        var dur = tl.EndTime - tl.StartTime;
        if (dur > TimeSpan.Zero && pos > dur) pos = dur;
        if (pos < TimeSpan.Zero) pos = TimeSpan.Zero;

        _snap = new MediaSnapshot(
            App: FriendlyApp(s.SourceAppUserModelId),
            Title: props.Title ?? "",
            Artist: props.Artist ?? "",
            Album: props.AlbumTitle ?? "",
            Playing: playing,
            PosMs: (long)pos.TotalMilliseconds,
            DurMs: (long)Math.Max(0, dur.TotalMilliseconds),
            ArtId: Art is null ? 0 : _artId,
            CanSeek: pb.Controls.IsPlaybackPositionEnabled);
    }

    public async Task<bool> Control(string action, long? ms)
    {
        var s = _mgr?.GetCurrentSession();
        if (s is null)
        {
            // No session: send the media key instead (wakes up Spotify, for example).
            if (action == "playpause") { Keys.Tap(Keys.VK_MEDIA_PLAY_PAUSE); return true; }
            return false;
        }
        var ok = action switch
        {
            "playpause" => await s.TryTogglePlayPauseAsync(),
            "next" => await s.TrySkipNextAsync(),
            "prev" => await s.TrySkipPreviousAsync(),
            "seek" when ms is { } m => await s.TryChangePlaybackPositionAsync(TimeSpan.FromMilliseconds(m).Ticks),
            _ => false,
        };
        try { await Poll(); } catch { }
        return ok;
    }

    private static string FriendlyApp(string id)
    {
        var l = id.ToLowerInvariant();
        if (l.Contains("spotify")) return "Spotify";
        if (l.Contains("chrome")) return "Chrome";
        if (l.Contains("firefox") || l.Contains("308046b0af4a39cb")) return "Firefox";
        if (l.Contains("msedge")) return "Edge";
        if (l.Contains("zune") || l.Contains("media")) return "Media Player";
        if (l.Contains("vlc")) return "VLC";
        return Path.GetFileNameWithoutExtension(id.Split('!')[0]);
    }
}
