using System.Diagnostics;

namespace PhoneBox.Agent;

/// <summary>
/// Linux / macOS: no tray icon (the agent usually runs as a systemd user service or a launchd agent). The settings live
/// in the browser at http://127.0.0.1:8775; this just says so in the log.
/// </summary>
public sealed class Tray(ILogger<Tray> log) : IHostedService
{
    public Task StartAsync(CancellationToken ct)
    {
        log.LogInformation("settings: http://127.0.0.1:8775/  (no tray icon on this system; run PhoneBoxAgent again to open the settings)");
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}

/// <summary>Windows ties helper processes to the agent with a job object; elsewhere they are stopped on shutdown.</summary>
public static class JobObject
{
    public static void Track(Process p) { }
}
