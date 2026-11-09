#if WINDOWS
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace PhoneBox.Agent;

/// <summary>Captures the Spotify desktop process tree and publishes only a downsampled volume envelope.</summary>
internal sealed class SpotifyWave(ILogger<SpotifyWave> log) : BackgroundService
{
    private const int SampleRate = 44_100;
    private const int Channels = 2;
    private const int BarCount = 40;
    private const int FramesPerBar = 88;
    private const int Loopback = 0x00020000;
    private const int Silent = 2;

    private long _requestedAt = long.MinValue / 2;
    private long _sampledAt;
    private volatile int[]? _bars;

    public int[]? Read()
    {
        Volatile.Write(ref _requestedAt, Environment.TickCount64);
        return Environment.TickCount64 - Volatile.Read(ref _sampledAt) < 350 ? _bars : null;
    }

    private bool Requested => Environment.TickCount64 - Volatile.Read(ref _requestedAt) < 2_000;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 20348)) return;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (Requested && FindSpotify() is { } pid)
                    await Capture(pid, ct);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                log.LogDebug("Spotify waveform: {Message}", ex.Message);
            }
            finally { _bars = null; }
            await Task.Delay(500, ct);
        }
    }

    private static int? FindSpotify()
    {
        var processes = Process.GetProcessesByName("Spotify");
        try
        {
            using var current = Process.GetCurrentProcess();
            return processes.Where(p => p.SessionId == current.SessionId && !p.HasExited)
                .OrderBy(p => p.StartTime).Select(p => (int?)p.Id).FirstOrDefault();
        }
        finally { foreach (var process in processes) process.Dispose(); }
    }

    private async Task Capture(int pid, CancellationToken ct)
    {
        using var process = Process.GetProcessById(pid);
        var client = await Activate(pid, ct);
        ICaptureClient? capture = null;
        var started = false;
        try
        {
            var format = new WaveFormat
            {
                Format = 1, Channels = Channels, SampleRate = SampleRate, BytesPerSecond = SampleRate * Channels * sizeof(short),
                BlockAlign = Channels * sizeof(short), BitsPerSample = 16,
            };
            Marshal.ThrowExceptionForHR(client.Initialize(0, Loopback, 0, 0, ref format, IntPtr.Zero));
            var iid = typeof(ICaptureClient).GUID;
            Marshal.ThrowExceptionForHR(client.GetService(ref iid, out var service));
            capture = (ICaptureClient)service;
            Marshal.ThrowExceptionForHR(client.Start());
            started = true;

            short[] samples = [];
            var bars = new int[BarCount];
            var bar = 0;
            var count = 0;
            var energy = 0d;
            while (!ct.IsCancellationRequested && Requested && !process.HasExited)
            {
                Marshal.ThrowExceptionForHR(capture.GetNextPacketSize(out var next));
                while (next > 0)
                {
                    Marshal.ThrowExceptionForHR(capture.GetBuffer(out var data, out var frames, out var flags, out _, out _));
                    try
                    {
                        var silent = (flags & Silent) != 0;
                        var length = checked((int)frames * Channels);
                        if (!silent)
                        {
                            if (samples.Length < length) samples = new short[length];
                            Marshal.Copy(data, samples, 0, length);
                        }
                        for (var i = 0; i < length; i += Channels)
                        {
                            if (!silent)
                            {
                                var left = samples[i] / 32768d;
                                var right = samples[i + 1] / 32768d;
                                energy += (left * left + right * right) / Channels;
                            }
                            if (++count < FramesPerBar) continue;
                            bars[bar++] = (int)Math.Min(100, Math.Sqrt(energy / count) * 280);
                            count = 0;
                            energy = 0;
                            if (bar < BarCount) continue;
                            _bars = bars;
                            Volatile.Write(ref _sampledAt, Environment.TickCount64);
                            bars = new int[BarCount];
                            bar = 0;
                        }
                    }
                    finally { Marshal.ThrowExceptionForHR(capture.ReleaseBuffer(frames)); }
                    Marshal.ThrowExceptionForHR(capture.GetNextPacketSize(out next));
                }
                await Task.Delay(12, ct);
            }
        }
        finally
        {
            if (started) client.Stop();
            if (capture is not null) Marshal.ReleaseComObject(capture);
            Marshal.ReleaseComObject(client);
        }
    }

    private static async Task<IAudioClient> Activate(int pid, CancellationToken ct)
    {
        var handler = new ActivationHandler();
        var iid = typeof(IAudioClient).GUID;
        var data = Marshal.AllocHGlobal(12);
        try
        {
            // AUDIOCLIENT_ACTIVATION_PARAMS: ProcessLoopback, target process ID, IncludeTargetProcessTree.
            Marshal.WriteInt32(data, 0, 1);
            Marshal.WriteInt32(data, 4, pid);
            Marshal.WriteInt32(data, 8, 0);
            var param = new ActivationParam { VariantType = 65 /* VT_BLOB */, Size = 12, Data = data };
            Marshal.ThrowExceptionForHR(ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, ref param, handler, out var operation));
            try { return await handler.Result.Task.WaitAsync(TimeSpan.FromSeconds(4), ct); }
            finally { Marshal.ReleaseComObject(operation); }
        }
        finally { Marshal.FreeHGlobal(data); }
    }

    [DllImport("Mmdevapi.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int ActivateAudioInterfaceAsync(string path, ref Guid iid, ref ActivationParam activation,
        IActivationHandler handler, out IActivationOperation operation);

    [StructLayout(LayoutKind.Sequential)]
    private struct ActivationParam
    {
        public ushort VariantType, Reserved1, Reserved2, Reserved3;
        public uint Size;
        public IntPtr Data;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WaveFormat
    {
        public ushort Format, Channels;
        public uint SampleRate, BytesPerSecond;
        public ushort BlockAlign, BitsPerSample, ExtraSize;
    }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    private sealed class ActivationHandler : IActivationHandler, IAgileObject
    {
        public readonly TaskCompletionSource<IAudioClient> Result = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int ActivateCompleted(IActivationOperation operation)
        {
            try
            {
                Marshal.ThrowExceptionForHR(operation.GetActivateResult(out var hr, out var instance));
                Marshal.ThrowExceptionForHR(hr);
                Result.TrySetResult((IAudioClient)instance);
            }
            catch (Exception ex) { Result.TrySetException(ex); }
            return 0;
        }
    }

    [ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAgileObject;

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivationHandler
    {
        [PreserveSig] int ActivateCompleted(IActivationOperation operation);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivationOperation
    {
        [PreserveSig] int GetActivateResult(out int hr, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig] int Initialize(int mode, int flags, long duration, long period, ref WaveFormat format, IntPtr session);
        [PreserveSig] int GetBufferSize(out uint size);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int mode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long normal, out long minimum);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ICaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out int flags, out ulong device, out ulong position);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }
}
#endif
