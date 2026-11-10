#if WINDOWS
using System.Runtime.InteropServices;

namespace PhoneBox.Agent;

/// <summary>
/// The hottest ACPI thermal zone, read from the "Thermal Zone Information" performance counter. Needs no admin
/// rights and no extra tool; on laptops the zone follows the CPU. Used when LibreHardwareMonitor is not running.
/// </summary>
internal sealed class ThermalZone : IDisposable
{
    private const uint FmtDouble = 0x200, MoreData = 0x800007D2;
    private IntPtr _query, _counter;

    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] private static extern uint PdhOpenQueryW(string? source, IntPtr user, out IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] private static extern uint PdhAddEnglishCounterW(IntPtr query, string path, IntPtr user, out IntPtr counter);
    [DllImport("pdh.dll")] private static extern uint PdhCollectQueryData(IntPtr query);
    [DllImport("pdh.dll")] private static extern uint PdhGetFormattedCounterArrayW(IntPtr counter, uint format, ref uint size, out uint count, IntPtr buffer);
    [DllImport("pdh.dll")] private static extern uint PdhCloseQuery(IntPtr query);

    /// <summary>Degrees Celsius, or null when the PC exposes no thermal zone.</summary>
    public double? Read()
    {
        if (_query == IntPtr.Zero)
        {
            if (PdhOpenQueryW(null, IntPtr.Zero, out _query) != 0) { _query = IntPtr.Zero; return null; }
            if (PdhAddEnglishCounterW(_query, @"\Thermal Zone Information(*)\High Precision Temperature", IntPtr.Zero, out _counter) != 0)
            {
                Dispose();
                return null;
            }
        }
        if (PdhCollectQueryData(_query) != 0) return null;
        uint size = 0;
        if (PdhGetFormattedCounterArrayW(_counter, FmtDouble, ref size, out _, IntPtr.Zero) != MoreData || size == 0) return null;
        var buffer = Marshal.AllocHGlobal((int)size);
        try
        {
            if (PdhGetFormattedCounterArrayW(_counter, FmtDouble, ref size, out var count, buffer) != 0) return null;
            double? best = null;
            // PDH_FMT_COUNTERVALUE_ITEM_W (x64): name pointer, status, padding, value = 24 bytes.
            var step = IntPtr.Size + 16;
            for (var i = 0; i < count; i++)
            {
                var item = buffer + i * step;
                if (Marshal.ReadInt32(item, IntPtr.Size) is not (0 or 1)) continue;   // PDH_CSTATUS_VALID_DATA / NEW_DATA
                var c = BitConverter.Int64BitsToDouble(Marshal.ReadInt64(item, IntPtr.Size + 8)) / 10 - 273.15;   // tenths of a kelvin
                if (c is > 0 and < 125 && (best is null || c > best)) best = c;
            }
            return best;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    public void Dispose()
    {
        if (_query != IntPtr.Zero) PdhCloseQuery(_query);
        _query = _counter = IntPtr.Zero;
    }
}
#endif
