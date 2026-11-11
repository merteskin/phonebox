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


def notify(title, text, **extra):
    http(f"{AGENT}/api/notify", json.dumps({"title": title, "text": text, **extra}).encode(),
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
FAST = float(os.getenv("BRIDGE_FAST", "3"))  # ana ekran fiyat kutularının yenileme aralığı (sn)
FAST_COINS = ("BTC", "ETH", "TAO")
_fast = {"at": 0.0}


MOVES = json.loads(os.getenv("BRIDGE_MOVES", "[[15, 10], [10, 5], [5, 3]]"))  # [dakika, %]: ani hareket uyarısı
_hist: dict[str, list] = {}   # coin -> [(zaman, fiyat)], son 15 dk
_moved: dict[tuple, tuple] = {}  # (coin, dakika) -> (zaman, %)
_flash: dict[str, float] = {}  # coin -> kutunun yanıp söneceği son an
_fund = {"at": 0.0, "data": {}}


def move_alert(c, last):
    """Fiyat son N dakikadaki dip/tepeye göre eşiği aştıysa bildirim gönderir ve kutuyu 1 dk yakıp söndürür."""
    now = time.time()
    h = _hist.setdefault(c, [])
    h.append((now, last))
    span = max(m for m, _ in MOVES) * 60
    while h and now - h[0][0] > span:
        h.pop(0)
    for mins, lim in MOVES:
        w = [p for t, p in h if now - t <= mins * 60]
        if len(w) < 2:
            continue
        lo, hi = min(w), max(w)
        pct = (last / lo - 1) * 100 if last - lo >= hi - last else (last / hi - 1) * 100
        if abs(pct) < lim:
            continue
        at, prev = _moved.get((c, mins), (0, 0))
        if now - at >= mins * 60 or pct * prev < 0 or abs(pct) - abs(prev) >= lim / 2:
            _moved[(c, mins)] = (now, pct)
            _flash[c] = now + 60
            try:
                notify(f"{c} {pct:+.1f}% · son {mins} dk", f"Son fiyat {fmt(last)}", level="warn", wake=True, seconds=10)
            except Exception:
                pass
        break  # en büyük eşik yeter


def fast():
    """Ana ekrandaki fiyat kutuları: OKX'in herkese açık ticker'ı, birkaç saniyede bir (key gerekmez)."""
    if time.time() - _fund["at"] >= 60:
        _fund["at"] = time.time()
        for c in FAST_COINS:
            try:
                f = http(f"{OKX}/api/v5/public/funding-rate?instId={c}-USDT-SWAP")["data"][0]
                _fund["data"][c] = float(f["fundingRate"]) * 100
            except Exception:
                pass
    for c in FAST_COINS:
        t = http(f"{OKX}/api/v5/market/ticker?instId={c}-USDT-SWAP")["data"][0]
        last = float(t["last"])
        ch = (last / float(t["open24h"]) - 1) * 100
        move_alert(c, last)
        fr = _fund["data"].get(c)
        push("px_" + c.lower(), {"title": c, "value": fmt(last),
                                 "sub": f"{ch:+.2f}% · 24s" + (f" · F {fr:+.3f}%" if fr is not None else ""),
                                 "spark": (_spark["data"].get(c) or []) + [last],
                                 "alert": time.time() < _flash.get(c, 0),
                                 "color": "#22c55e" if ch >= 0 else "#ef4444"})
    _fast["at"] = time.time()


def home_pos(board):
    """Ana ekran şeridi: açık pozisyonlar, bekleyen emirler ve kağıt pozisyonlar tek listede."""
    it = []
    for p in board["pos"]:
        liq = f' · liq {(float(p["liq"]) / float(p["mark"]) - 1) * 100:+.1f}%' if p.get("liq") and p.get("mark") else ""
        it.append({"label": f'{p["coin"]} {str(p.get("side") or "").upper()} {float(p.get("lev") or 0):.0f}x',
                   "value": f'{p["upnl"]:+,.2f} ${liq}', "level": "ok" if p["upnl"] >= 0 else "error"})
    for o in sorted(board["orders"], key=lambda o: abs(o.get("dist") or 999)):
        dist = f' · {o["dist"]:+.1f}%' if o.get("dist") is not None else ""
        it.append({"label": f'{o["coin"]} {o.get("dir") or ""} emri', "value": f'{fmt(o["px"])}{dist}'})
    for p in board["paper"]:
        it.append({"label": f'{p["coin"]} {str(p.get("side") or "").upper()} · kağıt',
                   "value": f'{p["upnl"]:+,.2f} $ ({p["pct"]:+.1f}%)', "level": "ok" if p["upnl"] >= 0 else "error"})
    push("home_pos", {"title": "Pozisyonlar ve emirler", "items": it or [{"label": "Açık pozisyon ya da emir yok", "value": ""}]})


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
        board = kripto_board(s)
        push("kripto", board)
        try:
            home_pos(board)
        except Exception as e:
            print(time.strftime("%H:%M:%S"), "pozisyon şeridi:", e)
        for c in board["coins"]:
            if c["s"] in FAST_COINS and time.time() - _fast["at"] > 15:  # hızlı döngü çalışmıyorsa yedek
                push("px_" + c["s"].lower(), {"title": c["s"], "value": fmt(c["px"]), "sub": f'{c["ch"]:+.2f}% · 24s', "spark": c["spark"],
                                              "color": "#22c55e" if c["ch"] >= 0 else "#ef4444"})
        try:
            charts([c for c in ("TAO", "BTC", "ETH") if any(x["s"] == c for x in board["coins"])])
        except Exception as e:
            print(time.strftime("%H:%M:%S"), "grafik hatası:", e)
        k = board["kpi"]
        if k.get("d7") is not None:
            push("realized", {"title": "Realized 7g", "value": f'{k["d7"]:+,.2f}', "unit": "USDT",
                              "sub": f'30g {k.get("d30") or 0:+,.2f} · win {k.get("win") or 0:.0f}%',
                              "color": "#22c55e" if k["d7"] >= 0 else "#ef4444"})
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


CHART_BARS = (("1m", 15), ("5m", 60), ("15m", 120), ("1H", 300), ("4H", 900), ("1D", 1800))  # bar -> yenileme sn
_chart: dict[tuple, tuple] = {}


def charts(coins):
    """Ana ekrandaki fiyat kutusuna dokununca açılan grafik için mum verisi (KriptoBot /api/candles, sadece GET).
    Her coin için tek push: chart_<coin> = {"bars": {"5m": [[t,o,h,l,c],...], ...}}."""
    for c in coins:
        bars, changed = {}, False
        for bar, every in CHART_BARS:
            at, d = _chart.get((c, bar), (0, None))
            if time.time() - at >= every or d is None:
                try:
                    if bar == "1m":  # KriptoBot 1m vermiyor: OKX'in herkese açık mum verisi (key gerekmez, yeni -> eski)
                        raw = [[float(v) for v in x[:5]] for x in reversed(http(
                            f"{OKX}/api/v5/market/candles?instId={c}-USDT-SWAP&bar=1m&limit=120")["data"])]
                    else:
                        raw = http(f"{KRIPTOBOT}/api/candles?inst={c}-USDT-SWAP&bar={bar}")["data"][-120:]
                    d = [[int(x[0] // 1000)] + [round(v, 6) for v in x[1:5]] for x in raw]
                    _chart[(c, bar)] = (time.time(), d)
                    changed = True
                except Exception:
                    pass
            if d:
                bars[bar] = d
        if changed and bars:
            push("chart_" + c.lower(), {"title": c, "bars": bars}, ttl=3600)


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


def air_loop():
    """Hava temizleyici (miio_air.py + air.json) varsa 15 sn'de bir "air" push'lar.
    Panel popup'ı komutu "air_cmd" push'u olarak bırakır ({"cmd": "auto", "at": ms}); her saniye bakılır."""
    try:
        import miio_air
    except ImportError:
        return
    last_read, done, first = 0.0, None, True
    while True:
        try:
            c = http(f"{AGENT}/api/push/air_cmd")
            at = (c or {}).get("at")
            if first:
                done = at  # açılışta eski komutu tekrar çalıştırma
            elif at and at != done:
                done = at
                miio_air.command(str((c.get("data") or {}).get("cmd") or "status").split())
                last_read = 0
        except Exception:
            pass  # komut yok (404) ya da cihaz o an cevap vermedi
        first = False
        if time.time() - last_read >= 15:
            last_read = time.time()
            try:
                a = miio_air.read()
                if a is None:
                    return  # air.json ya da pycryptodome yok
                push("air", a, ttl=120)
            except Exception:
                pass  # push süresi dolunca kutu boşalır
        time.sleep(1)


if __name__ == "__main__":
    import threading
    threading.Thread(target=air_loop, daemon=True).start()
    full = 0.0
    while True:
        if time.time() - full >= PERIOD:
            full = time.time()
            try:
                tick()
            except Exception as e:
                print(time.strftime("%H:%M:%S"), "hata:", e)
        try:
            fast()
        except Exception:
            pass  # OKX'e ulaşılamadı: kutular 20 sn'lik KriptoBot verisine döner
        time.sleep(FAST)
