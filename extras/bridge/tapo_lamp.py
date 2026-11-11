"""TP-Link Tapo ampul (ör. L530E) yerel kontrolü, KLAP protokolü ile.

Ampulde Tapo uygulaması > Ben > Üçüncü taraf uyumluluğu AÇIK olmalı (kapalıyken ampul yalnız TPAP konuşur).
Ayar: bu klasörde tapo.json -> {"ip": "...", "user": "<tapo e-posta>", "password": "..."}  (repo'ya girmez)
İlk kurulum: python tapo_lamp.py setup   (e-posta ve şifreyi sen yazarsın, ekranda görünmez)
Kullanım: python tapo_lamp.py status|on|off|toggle|bright <1-100>|temp <2500-6500>
AES için pycryptodome gerekir.
"""
import hashlib, json, os, struct, sys, urllib.request

CFG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tapo.json")
DEFAULT_IP = "192.168.1.109"


def _sha256(b):
    return hashlib.sha256(b).digest()


class Klap:
    def __init__(self, ip, user, password):
        self.base = "http://%s/app" % ip
        self.auth = _sha256(hashlib.sha1(user.encode()).digest() + hashlib.sha1(password.encode()).digest())
        self.cookie = None

    def _post(self, url, data):
        req = urllib.request.Request(url, data=data, method="POST")
        if self.cookie:
            req.add_header("Cookie", self.cookie)
        with urllib.request.urlopen(req, timeout=5) as r:
            ck = r.headers.get("Set-Cookie")
            if ck:
                self.cookie = ck.split(";")[0]
            return r.read()

    def login(self):
        local = os.urandom(16)
        try:
            r = self._post(self.base + "/handshake1", local)
        except urllib.error.HTTPError as e:
            raise SystemExit("Ampul KLAP'ı reddetti (%s). Tapo uygulamasında 'Üçüncü taraf uyumluluğu'nu aç." % e.code)
        remote, srv = r[:16], r[16:48]
        if srv != _sha256(local + remote + self.auth):
            raise SystemExit("Tapo e-posta/şifre yanlış (python tapo_lamp.py setup ile tekrar gir).")
        self._post(self.base + "/handshake2", _sha256(remote + local + self.auth))
        self.key = _sha256(b"lsk" + local + remote + self.auth)[:16]
        ivs = _sha256(b"iv" + local + remote + self.auth)
        self.iv, self.seq = ivs[:12], struct.unpack(">i", ivs[-4:])[0]
        self.sig = _sha256(b"ldk" + local + remote + self.auth)[:28]

    def call(self, method, params=None):
        from Crypto.Cipher import AES
        from Crypto.Util.Padding import pad, unpad
        if self.cookie is None:
            self.login()
        self.seq = (self.seq + 1) if self.seq < 2**31 - 1 else -2**31
        sb = struct.pack(">i", self.seq)
        body = json.dumps({"method": method, "params": params or {}}).encode()
        ct = AES.new(self.key, AES.MODE_CBC, self.iv + sb).encrypt(pad(body, 16))
        r = self._post("%s/request?seq=%d" % (self.base, self.seq), _sha256(self.sig + sb + ct) + ct)
        res = json.loads(unpad(AES.new(self.key, AES.MODE_CBC, self.iv + sb).decrypt(r[32:]), 16))
        if res.get("error_code"):
            raise RuntimeError("Tapo hata %s" % res["error_code"])
        return res.get("result")


def _cfg():
    with open(CFG, encoding="utf-8") as f:
        return json.load(f)


def client():
    c = _cfg()
    return Klap(c.get("ip", DEFAULT_IP), c["user"], c["password"])


def read():
    """Panel için kısa durum; tapo.json yoksa None."""
    if not os.path.exists(CFG):
        return None
    i = client().call("get_device_info")
    return {"on": bool(i.get("device_on")), "bright": i.get("brightness"),
            "temp": i.get("color_temp"), "hue": i.get("hue"), "sat": i.get("saturation")}


def main(a):
    cmd = a[0] if a else "status"
    if cmd == "setup":
        import getpass
        user = input("Tapo e-posta: ").strip()
        pw = getpass.getpass("Tapo şifre (görünmez): ")
        ip = input("Ampul IP [%s]: " % DEFAULT_IP).strip() or DEFAULT_IP
        Klap(ip, user, pw).login()  # hatalıysa burada durur, dosya yazılmaz
        with open(CFG, "w", encoding="utf-8") as f:
            json.dump({"ip": ip, "user": user, "password": pw}, f)
        print("Tamam, ampule bağlandım ve ayarı kaydettim.")
        return
    command(a)
    print(json.dumps(read(), ensure_ascii=False))


def command(a):
    """Panel/kısayol komutu: on|off|toggle|bright N|temp K (status = hiçbir şey yapma)."""
    cmd = a[0] if a else "status"
    d = client()
    if cmd in ("on", "off"):
        d.call("set_device_info", {"device_on": cmd == "on"})
    elif cmd == "toggle":
        d.call("set_device_info", {"device_on": not d.call("get_device_info").get("device_on")})
    elif cmd == "bright":
        d.call("set_device_info", {"device_on": True, "brightness": max(1, min(100, int(a[1])))})
    elif cmd == "temp":
        d.call("set_device_info", {"device_on": True, "color_temp": max(2500, min(6500, int(a[1])))})


if __name__ == "__main__":
    main(sys.argv[1:])
