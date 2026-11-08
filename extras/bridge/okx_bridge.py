"""PhoneBox kripto köprüsü: OKX + piyasa verisini PhoneBox agent'ına push'lar.

Yalnızca stdlib. PC'de agent ile aynı makinede çalışır (127.0.0.1:8775).
OKX pozisyonları için SADECE "Read" yetkili API key kullan (Trade/Withdraw KAPALI, IP whitelist AÇIK).
Env: OKX_KEY, OKX_SECRET, OKX_PASS (yoksa pozisyon kısmı atlanır).
Widget'lar: "Pushed value" ekle, key = btc / funding / positions / pnl / dominance, style = list veya big.
"""
import base64, datetime as dt, hashlib, hmac, json, os, time, urllib.request

AGENT = os.getenv("PHONEBOX_URL", "http://127.0.0.1:8775")
OKX = "https://www.okx.com"
INST = os.getenv("BRIDGE_INST", "BTC-USDT-SWAP,ETH-USDT-SWAP,SOL-USDT-SWAP").split(",")
ALERTS = json.loads(os.getenv("BRIDGE_ALERTS", '{"BTC-USDT-SWAP": 3.0}'))  # inst -> 24s % eşiği
PERIOD = int(os.getenv("BRIDGE_PERIOD", "20"))
_alerted: dict[str, float] = {}


def http(url, data=None, headers=None, method=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read() or b"null")


def push(key, payload, ttl=300):
    http(f"{AGENT}/api/push/{key}?ttl={ttl}", json.dumps(payload).encode(),
         {"Content-Type": "application/json"}, "POST")


def notify(title, text):
    http(f"{AGENT}/api/notify", json.dumps({"title": title, "text": text}).encode(),
         {"Content-Type": "application/json"}, "POST")


def okx_private(path):
    key, sec, pas = (os.getenv(k) for k in ("OKX_KEY", "OKX_SECRET", "OKX_PASS"))
    if not (key and sec and pas):
        return None
    ts = dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    sign = base64.b64encode(hmac.new(sec.encode(), f"{ts}GET{path}".encode(), hashlib.sha256).digest()).decode()
    return http(OKX + path, headers={"OK-ACCESS-KEY": key, "OK-ACCESS-SIGN": sign,
                                     "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": pas})["data"]


def fmt(x):
    x = float(x)
    return f"{x:,.0f}" if abs(x) >= 1000 else f"{x:,.2f}" if abs(x) >= 1 else f"{x:.4g}"


def lvl(pct):  # PhoneBox renk seviyeleri
    return "ok" if pct >= 0 else "warn" if pct > -3 else "error"


def tick():
    rows = []
    for inst in INST:
        t = http(f"{OKX}/api/v5/market/ticker?instId={inst}")["data"][0]
        last, op = float(t["last"]), float(t["sodUtc0"])
        pct = (last / op - 1) * 100
        rows.append({"label": inst.split("-")[0], "value": f"{fmt(last)}  {pct:+.2f}%", "level": lvl(pct)})
        lim = ALERTS.get(inst)
        if lim and abs(pct) >= lim and abs(pct - _alerted.get(inst, 0)) >= lim / 2:
            _alerted[inst] = pct
            notify(f"{inst} {pct:+.2f}%", f"Son fiyat {fmt(last)}")
    push("btc", {"title": "Perp fiyatlar (UTC0)", "items": rows})

    fr = []
    for inst in INST:
        f = http(f"{OKX}/api/v5/public/funding-rate?instId={inst}")["data"][0]
        r = float(f["fundingRate"]) * 100
        fr.append({"label": inst.split("-")[0], "value": f"{r:+.4f}%", "level": "warn" if abs(r) > 0.03 else "ok"})
    push("funding", {"title": "Funding (8s)", "items": fr})

    try:
        g = http("https://api.coingecko.com/api/v3/global")["data"]["market_cap_percentage"]
        push("dominance", {"title": "BTC dominance", "value": round(g["btc"], 2), "unit": "%"}, ttl=1800)
    except Exception:
        pass  # CoinGecko rate limit: sessizce geç

    pos = okx_private("/api/v5/account/positions")
    if pos is not None:
        items, total = [], 0.0
        for p in pos:
            upl = float(p.get("upl") or 0); total += upl
            items.append({"label": f'{p["instId"].split("-")[0]} {p.get("posSide") or ""} {p["pos"]}',
                          "value": f'{upl:+,.2f} ({float(p.get("uplRatio") or 0)*100:+.1f}%)',
                          "level": lvl(upl)})
        push("positions", {"title": "OKX pozisyonlar", "items": items or [{"label": "Açık pozisyon yok", "value": ""}]})
        push("pnl", {"title": "Toplam uPnL", "value": f"{total:+,.2f}", "unit": "USDT",
                     "color": "#3ddc84" if total >= 0 else "#ff5252"})


if __name__ == "__main__":
    while True:
        try:
            tick()
        except Exception as e:
            print(time.strftime("%H:%M:%S"), "hata:", e)
        time.sleep(PERIOD)
