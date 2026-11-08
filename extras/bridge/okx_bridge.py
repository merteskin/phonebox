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


_mkt = {"funding": {}, "dom": None}
_spark = {"at": 0, "data": {}}


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
        _mkt["funding"][inst.split("-")[0]] = r
        fr.append({"label": inst.split("-")[0], "value": f"{r:+.4f}%", "level": "warn" if abs(r) > 0.03 else "ok"})
    push("funding", {"title": "Funding (8s)", "items": fr})

    try:
        g = http("https://api.coingecko.com/api/v3/global")["data"]["market_cap_percentage"]
        _mkt["dom"] = g["btc"]
        push("dominance", {"title": "BTC dominance", "value": f"{g['btc']:.2f}", "unit": "%"}, ttl=1800)
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
    else:
        kriptobot()


KRIPTOBOT = os.getenv("KRIPTOBOT_URL", "http://127.0.0.1:8765")  # KriptoBot yerel paneli (salt-okunur GET)


def pct(x):
    return f"{x:+.2f}%"


def kriptobot():
    """OKX key yoksa verileri KriptoBot panelinin /api/summary'sinden alır. Key'e dokunmaz, sadece GET.
    Değerler string gönderilir (panel sayıları yuvarlamasın)."""
    try:
        s = http(KRIPTOBOT + "/api/summary")
    except Exception:
        return
    try:
        push("kripto", kripto_board(s))
    except Exception as e:
        print("kripto board:", e)
    tick = ((s.get("tickers") or {}).get("data") or {})
    px = {k: v.get("last") for k, v in tick.items()}

    # Piyasa: KriptoBot'un izlediği tüm coinler, 24s değişime göre sıralı
    rows = sorted(tick.items(), key=lambda kv: -(kv[1].get("change") or 0))
    push("market", {"title": "Piyasa · 24s", "items": [
        {"label": k, "value": f'{fmt(v["last"])}   {pct((v.get("change") or 0) * 100)}', "level": lvl((v.get("change") or 0) * 100)}
        for k, v in rows if v.get("last")]})

    live = (s.get("live") or {}).get("data") or {}
    total = 0.0
    items = []
    for p in live.get("positions") or []:
        upl = float(p.get("upl") or p.get("pnl") or 0); total += upl
        r = p.get("uplRatio") or p.get("upl_ratio")
        items.append({"label": f'{p.get("coin", "?")} {p.get("side", "")} {p.get("size") or p.get("qty") or ""}  '
                               f'{fmt(p.get("entry") or p.get("avgPx") or 0)} → {fmt(p.get("mark") or p.get("markPx") or px.get(p.get("coin")) or 0)}',
                      "value": f"{upl:+,.2f}" + (f" ({float(r) * 100:+.1f}%)" if r is not None else ""), "level": lvl(upl)})
    for o in live.get("orders") or []:
        last = px.get(o.get("coin"))
        dist = f"  ({(float(o['px']) / last - 1) * 100:+.1f}%)" if last and o.get("px") else ""
        items.append({"label": f'Limit {o.get("coin", "?")} {o.get("direction") or o.get("side", "")} {int(o.get("lever") or 0)}x',
                      "value": f'{fmt(o.get("px") or 0)}{dist}', "level": "info"})
    push("positions", {"title": "OKX canlı · pozisyon + limit",
                       "items": items or [{"label": "Açık pozisyon / emir yok", "value": ""}]})

    paper = s.get("paper") or {}
    pitems = []
    ptotal = 0.0
    for p in paper.get("positions") or []:
        last, entry = px.get(p.get("coin")), float(p.get("entry") or 0)
        qty = float(p.get("qty_open") or p.get("qty") or 0)
        sgn = 1 if p.get("side") == "long" else -1
        upl = (last - entry) * qty * sgn if last else 0.0
        ptotal += upl
        r = (last / entry - 1) * 100 * sgn if last and entry else 0.0
        pitems.append({"label": f'{p["coin"]} {p.get("side", "")}  {fmt(entry)} → {fmt(last or 0)}',
                       "value": f"{upl:+,.2f} ({r:+.1f}%)", "level": lvl(upl)})
    bal = paper.get("balance")
    push("paper", {"title": "Kağıt" + (f" · bakiye {bal:,.0f}$" if bal else "") + f" · uPnL {ptotal:+,.2f}",
                   "items": pitems or [{"label": "Açık kağıt pozisyon yok", "value": ""}]})

    eq = live.get("equity")
    if eq is not None:
        avail = (live.get("usdt") or {}).get("availEq")
        push("equity", {"title": "OKX equity" + (f" · boşta {avail:,.0f}" if avail else ""), "value": f"{eq:,.2f}", "unit": "USDT"})
    push("pnl", {"title": "Canlı uPnL", "value": f"{total:+,.2f}", "unit": "USDT",
                 "color": "#3ddc84" if total >= 0 else "#ff5252"})

    al = []
    for a in (s.get("alerts") or [])[:6]:
        t = time.strftime("%d.%m %H:%M", time.localtime(a["created"] / 1000)) if a.get("created") else ""
        al.append({"label": f'{a.get("coin", "")} · {a.get("title", "")}', "value": t, "level": "warn"})
    push("alerts", {"title": "KriptoBot uyarıları", "items": al or [{"label": "Uyarı yok", "value": ""}]}, ttl=900)


def sparks(coins):
    """24 saatlik 1S kapanışlar (KriptoBot paneli üzerinden, 5 dakikada bir)."""
    if time.time() - _spark["at"] < 300 and _spark["data"]:
        return _spark["data"]
    out = {}
    for c in coins:
        try:
            d = http(f"{KRIPTOBOT}/api/candles?inst={c}-USDT-SWAP&bar=1H")["data"][-24:]
            out[c] = [round(x[4], 6) for x in d]
        except Exception:
            pass
    _spark.update(at=time.time(), data=out)
    return out


def kripto_board(s):
    """Özel "kripto" widget'ı için tek JSON: KPI, coin tablosu, pozisyonlar, emirler, kağıt, kapanışlar, alarmlar."""
    tick_ = ((s.get("tickers") or {}).get("data") or {})
    px = {k: v.get("last") for k, v in tick_.items()}
    sp = sparks(list(tick_))
    coins = sorted(({"s": k, "px": v["last"], "ch": (v.get("change") or 0) * 100, "vol": v.get("vol_usd"),
                     "hi": v.get("high24h"), "lo": v.get("low24h"), "spark": sp.get(k, [])}
                    for k, v in tick_.items() if v.get("last")), key=lambda c: -c["ch"])
    live = (s.get("live") or {}).get("data") or {}
    pos = []
    for p in live.get("positions") or []:
        mark = p.get("mark") or p.get("markPx") or px.get(p.get("coin"))
        pos.append({"coin": p.get("coin"), "side": p.get("side"), "size": p.get("size") or p.get("qty"),
                    "entry": p.get("entry") or p.get("avgPx"), "mark": mark, "lev": p.get("lever"),
                    "upnl": float(p.get("upl") or p.get("pnl") or 0), "liq": p.get("liq") or p.get("liqPx")})
    orders = [{"coin": o.get("coin"), "dir": o.get("direction") or o.get("side"), "px": o.get("px"), "lev": o.get("lever"),
               "dist": (float(o["px"]) / px[o["coin"]] - 1) * 100 if o.get("px") and px.get(o.get("coin")) else None}
              for o in live.get("orders") or []]
    paper = []
    pb = s.get("paper") or {}
    for p in pb.get("positions") or []:
        last, entry = px.get(p.get("coin")), float(p.get("entry") or 0)
        sg = 1 if p.get("side") == "long" else -1
        q = float(p.get("qty_open") or p.get("qty") or 0)
        paper.append({"coin": p["coin"], "side": p.get("side"), "entry": entry, "mark": last, "stop": p.get("stop"),
                      "tp": p.get("tp1"), "upnl": (last - entry) * q * sg if last else 0.0,
                      "pct": (last / entry - 1) * 100 * sg if last and entry else 0.0, "strat": p.get("strategy")})
    closed, stats = [], {}
    try:
        h = http(KRIPTOBOT + "/api/history")
        lt = sorted(((h.get("live") or {}).get("data") or []), key=lambda t: -(t.get("closed_at") or 0))
        now = time.time() * 1000
        for name, days in (("d1", 1), ("d7", 7), ("d30", 30)):
            stats[name] = sum(float(t.get("pnl") or 0) for t in lt if now - (t.get("closed_at") or 0) < days * 864e5)
        w = [t for t in lt if now - (t.get("closed_at") or 0) < 30 * 864e5]
        stats["win"] = (sum(1 for t in w if (t.get("pnl") or 0) > 0) / len(w) * 100) if w else None
        stats["n"] = len(w)
        closed = [{"coin": t.get("coin"), "side": t.get("side"), "pnl": t.get("pnl"), "at": t.get("closed_at"),
                   "src": "OKX"} for t in lt[:4]]
        pt = sorted((h.get("trades") or []), key=lambda t: -(t.get("closed_at") or 0))
        closed += [{"coin": t.get("coin"), "side": t.get("side"), "pnl": t.get("pnl"), "at": t.get("closed_at"),
                    "src": "Kağıt"} for t in pt[:3]]
        closed.sort(key=lambda t: -(t["at"] or 0))
    except Exception:
        pass
    st = s.get("status") or {}
    cal = ((s.get("calendar") or {}).get("next") or [])[:1]
    return {
        "kpi": {"equity": live.get("equity"), "avail": (live.get("usdt") or {}).get("availEq"),
                "upnl": sum(p["upnl"] for p in pos), "paperBal": pb.get("balance"),
                "paperUpnl": sum(p["upnl"] for p in paper), "dom": _mkt["dom"], **stats},
        "funding": _mkt["funding"], "coins": coins, "pos": pos, "orders": orders, "paper": paper,
        "closed": closed[:5],
        "alerts": [{"coin": a.get("coin"), "t": a.get("title"), "at": a.get("created")} for a in (s.get("alerts") or [])[:5]],
        "bot": {"phase": st.get("phase"), "paused": st.get("paused"), "hb": st.get("heartbeat_age"),
                "okx": (s.get("settings") or {}).get("okx_mode"),
                "next": {"name": cal[0]["name"], "at": cal[0]["at"]} if cal else None},
    }


if __name__ == "__main__":
    while True:
        try:
            tick()
        except Exception as e:
            print(time.strftime("%H:%M:%S"), "hata:", e)
        time.sleep(PERIOD)
