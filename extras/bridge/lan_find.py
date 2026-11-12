"""DHCP ile IP'si değişen LAN cihazını MAC adresinden yeniden bulur (yalnız stdlib, Windows `arp -a`).

/24 alt ağın her adresine tek bir UDP paketi atıp ARP tablosunu doldurur, sonra MAC'i arar.
Bulunca ayar dosyasındaki "ip" alanını günceller.
"""
import json, re, socket, subprocess, time

_last: dict[str, float] = {}


def _arp():
    out = subprocess.run(["arp", "-a"], capture_output=True, text=True,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    return {m.group(2).lower().replace(":", "-"): m.group(1)
            for m in re.finditer(r"(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F]{2}(?:[-:][0-9a-fA-F]{2}){5})", out)}


def find_ip(mac, old_ip, port=9):
    mac = mac.lower().replace(":", "-")
    ip = _arp().get(mac)
    if ip and ip != old_ip:
        return ip
    base = old_ip.rsplit(".", 1)[0]
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    for i in range(1, 255):
        try:
            s.sendto(b"\0", ("%s.%d" % (base, i), port))
        except OSError:
            pass
    s.close()
    time.sleep(1.5)
    return _arp().get(mac)


def rediscover(cfg_path, every=120):
    """cfg'deki "mac" ile yeni IP'yi bulup yazar; değiştiyse yeni IP'yi döndürür. En sık `every` sn'de bir dener."""
    now = time.time()
    if now - _last.get(cfg_path, 0) < every:
        return None
    _last[cfg_path] = now
    try:
        with open(cfg_path, encoding="utf-8") as f:
            c = json.load(f)
        if not c.get("mac"):
            return None
        ip = find_ip(c["mac"], c.get("ip", "192.168.1.1"))
        if not ip or ip == c.get("ip"):
            return None
        c["ip"] = ip
        with open(cfg_path, "w", encoding="utf-8") as f:
            json.dump(c, f)
        return ip
    except (OSError, ValueError):
        return None
