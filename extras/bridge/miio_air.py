"""Xiaomi Mi Air Purifier (miIO, ör. zhimi.airpurifier.mc2 / 2H) okuması -> PhoneBox push "air".

Cihaz ağda UDP 54321'den, Mi hesabından alınan token ile yerel konuşur (buluta gitmez).
Ayar: bu klasörde air.json -> {"ip": "192.168.1.137", "token": "<32 hex>"}  (repo'ya girmez)
AES için pycryptodome gerekir (pip install --user pycryptodome); yoksa sessizce atlanır.
"""
import hashlib, json, os, socket, struct, time

CFG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "air.json")


class Miio:
    def __init__(self, ip, token):
        from Crypto.Cipher import AES  # noqa: F401  (yoksa ImportError -> çağıran atlar)
        self.ip, self.token = ip, bytes.fromhex(token)
        self.key = hashlib.md5(self.token).digest()
        self.iv = hashlib.md5(self.key + self.token).digest()
        self.did, self.stamp, self.t0 = None, 0, 0.0
        self.id = int.from_bytes(os.urandom(2), "big") % 9000  # cihaz tekrar eden id'leri yok sayıyor

    def _aes(self):
        from Crypto.Cipher import AES
        return AES.new(self.key, AES.MODE_CBC, self.iv)

    def _sock(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(3)
        return s

    def hello(self):
        with self._sock() as s:
            s.sendto(bytes.fromhex("21310020" + "ff" * 28), (self.ip, 54321))
            h, _ = s.recvfrom(1024)
        self.did, self.stamp, self.t0 = h[8:12], struct.unpack(">I", h[12:16])[0], time.time()

    def call(self, method, params):
        try:
            return self._call(method, params)
        except OSError:
            return self._call(method, params)  # tek seferlik tekrar

    def _call(self, method, params):
        if self.did is None or time.time() - self.t0 > 120:
            self.hello()
        self.id = self.id % 9999 + 1
        raw = json.dumps({"id": self.id, "method": method, "params": params}).encode()
        pad = 16 - len(raw) % 16
        body = self._aes().encrypt(raw + bytes([pad]) * pad)
        hdr = struct.pack(">HHI", 0x2131, 32 + len(body), 0) + self.did + struct.pack(">I", self.stamp + int(time.time() - self.t0) + 1)
        pkt = hdr + hashlib.md5(hdr + self.token + body).digest() + body
        try:
            with self._sock() as s:
                s.sendto(pkt, (self.ip, 54321))
                r, _ = s.recvfrom(4096)
        except OSError:
            self.did = None  # bir dahaki sefere yeniden el sıkış
            raise
        d = self._aes().decrypt(r[32:])
        res = json.loads(d[:-d[-1]].rstrip(b"\x00"))
        if "error" in res:
            raise RuntimeError(res["error"])
        return res["result"]

    def props(self, names):
        out = {}
        for i in range(0, len(names), 3):  # mc2 tek seferde çok özellik isteyince cevap vermiyor
            part = names[i:i + 3]
            out.update(zip(part, self.call("get_prop", part)))
        return out


_dev = None


def read():
    """Temizleyicinin durumunu sözlük olarak döndürür; ayar/kitaplık yoksa None."""
    global _dev
    if _dev is None:
        try:
            with open(CFG, encoding="utf-8") as f:
                c = json.load(f)
            _dev = Miio(c["ip"], c["token"])
        except (OSError, ValueError, KeyError, ImportError):
            return None
    p = _dev.props(["power", "mode", "aqi", "humidity", "temp_dec", "favorite_level", "filter1_life", "f1_hour_used", "f1_hour"])
    return {"on": p["power"] == "on", "mode": p["mode"], "pm25": p["aqi"], "hum": p["humidity"],
            "temp": (p["temp_dec"] or 0) / 10, "fav": p["favorite_level"], "filter": p["filter1_life"],
            "filterUsedH": p["f1_hour_used"], "filterH": p["f1_hour"]}


def command(args):
    """CLI: on | off | toggle | auto | silent | favorite [1-14] | night | day"""
    read()  # _dev'i kurar
    d = _dev
    cmd = (args or ["status"])[0]
    if cmd in ("on", "off"):
        d.call("set_power", [cmd])
    elif cmd == "toggle":
        d.call("set_power", ["off" if d.props(["power"])["power"] == "on" else "on"])
    elif cmd in ("auto", "silent", "favorite"):
        d.call("set_power", ["on"])
        d.call("set_mode", [cmd])
        if cmd == "favorite" and len(args) > 1:
            d.call("set_level_favorite", [max(1, min(14, int(args[1])))])
    elif cmd == "night":  # uyku modu + ışıklar ve bip kapalı
        d.call("set_power", ["on"])
        d.call("set_mode", ["silent"])
        for m, v in (("set_led", "off"), ("set_buzzer", "off")):
            try:
                d.call(m, [v])
            except Exception:
                pass
    elif cmd == "day":  # otomatik mod + ışıklar açık
        d.call("set_power", ["on"])
        d.call("set_mode", ["auto"])
        for m, v in (("set_led", "on"), ("set_buzzer", "on")):
            try:
                d.call(m, [v])
            except Exception:
                pass
    print(read())


if __name__ == "__main__":
    import sys
    command(sys.argv[1:])
