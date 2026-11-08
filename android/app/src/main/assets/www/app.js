'use strict';

// PhoneBox desk panel. Pages are 12 × 6 grids of widgets, designed in the agent's settings page.
// The panel talks to the PhoneBox agent through "/agent/*", which the Android shell proxies over USB
// (adb reverse) or Wi-Fi to the computer.

const API = '/agent/api';
const LOCALE = 'en-GB';
const COLS = 12, ROWS = 6;
const $ = (id) => document.getElementById(id);
const bridge = typeof Android !== 'undefined' ? Android : null;
// Live preview inside the agent's layout editor: the layout comes from the editor (unsaved), not from the agent.
const PREVIEW = new URLSearchParams(location.search).has('preview') && window.parent !== window;

/** Used until the agent has sent its settings once (first start without a connection). */
const FALLBACK_PAGES = [{
  id: 'home', title: 'Home', icon: '🏠', enabled: true, widgets: [
    { id: 'clock', type: 'clock', x: 0, y: 0, w: 6, h: 4, options: {} },
    { id: 'media', type: 'media', x: 6, y: 0, w: 6, h: 4, options: {} },
    { id: 'cpu', type: 'stat', x: 0, y: 4, w: 3, h: 2, options: { metric: 'cpu' } },
    { id: 'gpu', type: 'stat', x: 3, y: 4, w: 3, h: 2, options: { metric: 'gpu' } },
    { id: 'ram', type: 'stat', x: 6, y: 4, w: 3, h: 2, options: { metric: 'ram' } },
    { id: 'net', type: 'stat', x: 9, y: 4, w: 3, h: 2, options: { metric: 'net' } },
  ],
}];

const DEFAULT_CFG = {
  weather: { city: 'Tallinn', lat: 59.437, lon: 24.745 },
  night: { enabled: true, start: '00:30', end: '07:30', brightness: 0.02 },
  display: { showSeconds: true, idleReturnSec: 90, vibrate: true, volumeKeys: true },
  pages: FALLBACK_PAGES,
  shortcuts: [],
};

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
};

let cfg = PREVIEW ? { ...DEFAULT_CFG, pages: [] } : { ...DEFAULT_CFG, ...store.get('cfg', {}) };
let cfgVersion = null;
let online = null;
let lastTouch = Date.now();
let wakeUntil = 0;
let nightOn = null;
let evSeq = null;          // last agent event seen (notifications, page switches…)
let pushVersion = null;

/** Latest data from the agent and the web; widgets read from here. */
const D = { state: null, quotas: null, work: null, procs: null, push: {}, weather: null, notes: store.get('notes', []) };

const HIST = 90;
const hist = { cpu: [], gpu: [], ram: [], vram: [], down: [], up: [], ping: [], gputemp: [], cputemp: [] };
const pushHist = (k, v) => { const a = hist[k]; a.push(v ?? 0); if (a.length > HIST) a.shift(); };

// ---------------------------------------------------------------- helpers
async function api(path, method = 'GET', timeout = 2500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(API + path, { method, signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? r.json() : r.text();
  } finally { clearTimeout(t); }
}

const haptic = () => { try { bridge && bridge.haptic(); } catch (_) {} };
const buzz = (p) => { try { if (bridge && !nightOn && cfg.display?.vibrate !== false) bridge.buzz(p); } catch (_) {} };
const transport = () => { try { return bridge ? bridge.transport() : ''; } catch (_) { return ''; } };

/** h('div', 'cls', child, 'text', [more]) */
function h(tag, cls, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids.flat(3)) if (k != null && k !== false) e.append(k.nodeType ? k : String(k));
  return e;
}

const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + pad(s % 60); };
function fmtRate(bps) {
  if (bps == null) return ['—', ''];
  if (bps >= 1e9) return [(bps / 1e9).toFixed(1), 'GB/s'];
  if (bps >= 1e6) return [(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1), 'MB/s'];
  if (bps >= 1e3) return [(bps / 1e3).toFixed(0), 'KB/s'];
  return [Math.round(bps).toString(), 'B/s'];
}
const rateStr = (b) => fmtRate(b).join(' ');
function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr} h ${m % 60} min`;
  const d = Math.floor(hr / 24);
  return `${d} d ${hr % 24} h`;
}
function shortDur(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const hr = Math.floor(m / 60);
  return hr < 24 ? `${hr}h ${m % 60}m` : `${Math.floor(hr / 24)}d`;
}
const ago = (ts) => { const d = Date.now() - ts; return d < 45_000 ? 'just now' : shortDur(d) + ' ago'; };
const r1 = (v) => (v == null ? '—' : (Math.round(v * 10) / 10).toString());
const fmtMem = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB');
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const color = (c) => (c && c.startsWith('--') ? cssVar(c) : c);

let toastTimer = 0;
function toast(msg, kind = '', title = '', seconds = 2.6) {
  const t = $('toast');
  t.replaceChildren(...(title ? [h('b', null, title), h('span', null, msg)] : [h('span', null, msg)]));
  t.className = 'toast on ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast ' + kind), Math.max(1, seconds) * 1000);
}

// ---------------------------------------------------------------- charts
function sizeCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(c.clientWidth * dpr)), hh = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
  return [c.getContext('2d'), w, hh, dpr];
}

/** Draws series as area charts. series: [{ data, color, max }] */
function chart(canvas, series, opts = {}) {
  if (!canvas.clientWidth) return;
  const [g, w, hh, dpr] = sizeCanvas(canvas);
  g.clearRect(0, 0, w, hh);
  if (opts.grid) {
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.lineWidth = 1;
    for (let i = 1; i < 4; i++) { const y = Math.round((hh * i) / 4) + 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  }
  const top = 4 * dpr;
  for (const s of series) {
    const d = s.data;
    if (d.length < 2) continue;
    const max = s.max || 1;
    const step = w / (HIST - 1);
    const x0 = w - (d.length - 1) * step;
    const y = (v) => hh - (Math.min(v, max) / max) * (hh - top);
    g.beginPath();
    g.moveTo(x0, y(d[0]));
    for (let i = 1; i < d.length; i++) g.lineTo(x0 + i * step, y(d[i]));
    g.lineWidth = 1.6 * dpr;
    g.strokeStyle = s.color;
    g.lineJoin = 'round';
    g.stroke();
    g.lineTo(w, hh);
    g.lineTo(x0, hh);
    g.closePath();
    const grad = g.createLinearGradient(0, 0, 0, hh);
    grad.addColorStop(0, s.color + '55');
    grad.addColorStop(1, s.color + '00');
    g.fillStyle = grad;
    g.fill();
  }
}

function ringSvg(pct, elapsed) {
  const r = 42, c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, pct)) / 100);
  let tick = '';
  if (elapsed != null) {
    const a = elapsed * 2 * Math.PI;
    const p = (rad) => [50 + Math.cos(a) * rad, 50 + Math.sin(a) * rad].map((v) => v.toFixed(1));
    const [x1, y1] = p(35), [x2, y2] = p(49);
    tick = `<line class="pace" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }
  return `<svg viewBox="0 0 100 100"><circle class="bg" cx="50" cy="50" r="${r}"/>` +
    `<circle class="fg" cx="50" cy="50" r="${r}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>${tick}</svg>`;
}

// ---------------------------------------------------------------- metrics (stat, gauge, chart widgets)
const shortCpu = (n) => (n || '').replace(/^(AMD|Intel\(R\))\s*/, '').split(' ').slice(0, 4).join(' ');
const gpuOf = (s) => s?.pc?.gpu;
const netMax = () => Math.max(1, ...hist.down, ...hist.up) * 1.15;

const METRICS = {
  cpu: { label: 'CPU', name: 'Processor', color: '--cpu', unit: '%', max: () => 100, val: (s) => s.pc?.cpu,
    sub: (s) => (s.pc?.cpuTemp != null ? `${Math.round(s.pc.cpuTemp)}°C` : shortCpu(s.pc?.cpuName)), title: (s) => s.pc?.cpuName },
  gpu: { label: 'GPU', name: 'Graphics', color: '--gpu', unit: '%', max: () => 100, val: (s) => gpuOf(s)?.util,
    sub: (s) => (gpuOf(s) ? `${Math.round(gpuOf(s).temp)}°C · ${Math.round(gpuOf(s).power)} W` : 'No GPU data'), title: (s) => gpuOf(s)?.name },
  ram: { label: 'RAM', name: 'Memory', color: '--ram', unit: 'GB', max: (s) => s.pc?.ramTotalGb || 1, val: (s) => s.pc?.ramUsedGb, fmt: r1,
    pct: (s) => (s.pc ? (s.pc.ramUsedGb / s.pc.ramTotalGb) * 100 : null), sub: (s) => (s.pc ? `/ ${Math.round(s.pc.ramTotalGb)} GB` : '') },
  vram: { label: 'VRAM', name: 'Video memory', color: '--gpu', unit: '%', max: () => 100,
    val: (s) => (gpuOf(s)?.vramTotal ? (gpuOf(s).vramUsed / gpuOf(s).vramTotal) * 100 : null),
    sub: (s) => (gpuOf(s)?.vramTotal ? `${r1(gpuOf(s).vramUsed)} / ${Math.round(gpuOf(s).vramTotal)} GB` : '') },
  net: { label: 'NETWORK', name: 'Network', color: '--net', rate: true, hist: 'down', max: netMax, val: (s) => s.pc?.netDownBps,
    sub: (s) => '↑ ' + rateStr(s.pc?.netUpBps) + (s.ping?.ms != null ? ` · ${Math.round(s.ping.ms)} ms` : '') },
  down: { label: 'DOWNLOAD', name: 'Download', color: '--net', rate: true, max: netMax, val: (s) => s.pc?.netDownBps },
  up: { label: 'UPLOAD', name: 'Upload', color: '--up', rate: true, max: netMax, val: (s) => s.pc?.netUpBps },
  ping: { label: 'PING', name: 'Ping', color: '#38bdf8', unit: 'ms', max: () => Math.max(50, ...hist.ping) * 1.2, val: (s) => s.ping?.ms,
    sub: (s) => (s.ping ? `avg ${s.ping.avgMs ?? '—'} ms · loss ${s.ping.lossPct}%` : '') },
  gputemp: { label: 'GPU TEMP', name: 'GPU temperature', color: '#f97316', unit: '°C', max: () => 100, val: (s) => gpuOf(s)?.temp,
    sub: (s) => (gpuOf(s) ? `Fan ${Math.round(gpuOf(s).fan)}% · ${Math.round(gpuOf(s).clock)} MHz` : 'No GPU data') },
  cputemp: { label: 'CPU TEMP', name: 'CPU temperature', color: '#fb7185', unit: '°C', max: () => 100, val: (s) => s.pc?.cpuTemp,
    sub: (s) => (s.pc?.cpuTemp == null ? 'needs LibreHardwareMonitor' : shortCpu(s.pc?.cpuName)) },
};

function metricText(m, s) {
  const v = m.val(s);
  if (m.rate) return fmtRate(v);
  if (v == null) return ['—', m.unit || ''];
  return [m.fmt ? m.fmt(v) : String(Math.round(v)), m.unit || ''];
}

// ---------------------------------------------------------------- weather (Open-Meteo, straight from the phone)
const WX = {
  0: ['Clear', '☀️', '🌙'], 1: ['Mostly clear', '🌤️', '🌙'], 2: ['Partly cloudy', '⛅', '☁️'], 3: ['Overcast', '☁️', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Rime fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'], 56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'], 66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
  80: ['Light showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Heavy showers', '⛈️'], 85: ['Snow showers', '🌨️'], 86: ['Heavy snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm, hail', '⛈️'], 99: ['Severe hail', '⛈️'],
};
const wxIcon = (code, day = 1) => { const x = WX[code] || ['—', '🌡️']; return day === 0 && x[2] ? x[2] : x[1]; };

async function loadWeather(force = false) {
  const { lat, lon } = cfg.weather || DEFAULT_CFG.weather;
  const key = `v3:${lat},${lon}`;
  const cached = store.get('wx', null);
  if (cached && cached.key === key && !D.weather) { D.weather = cached.data; emit('weather'); }
  if (!force && cached && cached.key === key && Date.now() - cached.at < 14 * 60_000) return;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      '&current=temperature_2m,apparent_temperature,weather_code,is_day' +
      '&hourly=temperature_2m,weather_code,precipitation_probability,is_day' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,daylight_duration,uv_index_max' +
      '&timezone=auto&forecast_days=7';
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 8000);
    const data = await (await fetch(url, { signal: ctl.signal })).json();
    store.set('wx', { key, at: Date.now(), data });
    D.weather = data;
    emit('weather');
  } catch (_) { if (!D.weather) emit('weather'); }
}

function wxLines() {
  const w = D.weather;
  if (!w || !w.current) return null;
  const c = w.current, d = w.daily || {};
  const desc = (WX[c.weather_code] || ['—'])[0];
  const hi = d.temperature_2m_max ? Math.round(d.temperature_2m_max[0]) : null;
  const lo = d.temperature_2m_min ? Math.round(d.temperature_2m_min[0]) : null;
  return {
    icon: wxIcon(c.weather_code, c.is_day),
    temp: Math.round(c.temperature_2m) + '°',
    desc: `${desc} · ${cfg.weather?.city || ''}`,
    range: (hi != null ? `↑${hi}° ↓${lo}° · ` : '') + `Feels like ${Math.round(c.apparent_temperature)}°`,
  };
}

function wxBlock() {
  const e = h('div', 'wx', h('span', 'wx-icon', '·'), h('span', 'wx-temp', '--°'),
    h('div', 'wx-meta', h('span', 'wx-desc', 'Loading weather…'), h('span', 'wx-range muted')));
  e.update = () => {
    const l = wxLines();
    if (!l) { e.querySelector('.wx-desc').textContent = D.weather === null ? 'Loading weather…' : 'Weather unavailable'; return; }
    e.querySelector('.wx-icon').textContent = l.icon;
    e.querySelector('.wx-temp').textContent = l.temp;
    e.querySelector('.wx-desc').textContent = l.desc;
    e.querySelector('.wx-range').textContent = l.range;
  };
  return e;
}

// ---------------------------------------------------------------- status line (clock widget)
function phoneBattery() {
  if (!bridge) return '';
  try { const b = JSON.parse(bridge.battery()); return `📱 ${b.level}%${b.plugged ? ' ⚡' : ''}`; } catch (_) { return ''; }
}

function quotaProviders() { return D.quotas?.providers || []; }

function renderStatus(el) {
  const via = transport();
  const name = online ? (D.state?.host || 'PC') + (via === 'wifi' ? ' · Wi-Fi' : via === 'usb' ? ' · USB' : '') : online === false ? 'PC not connected' : 'Connecting…';
  const kids = [h('span', 'dot ' + (online ? 'on' : online === false ? 'off' : '')), h('span', null, name)];
  const bat = phoneBattery();
  if (bat) kids.push(h('span', 'sep', '·'), h('span', null, bat));
  for (const p of quotaProviders()) {
    const l = p.limits?.[0];
    if (!l) continue;
    const s = h('span', 'qm', h('span', 'sep', '·'), p.name + ' ', h('b', null, Math.round(l.percent) + '%'));
    if (l.percent >= 95) s.style.color = '#f87171'; else if (l.percent >= 80) s.style.color = '#fbbf24';
    kids.push(s);
  }
  const waiting = (D.work?.sessions || []).filter((s) => s.status === 'waiting').length;
  if (waiting) kids.push(h('span', 'sep', '·'), h('span', 'smini', `${waiting} waiting`));
  const u = D.state?.update;
  if (u) kids.push(h('span', 'sep', '·'), h('span', 'upd', u.app && via !== 'usb' ? `⬆ ${u.latest}: plug in USB to update` : `⬆ ${u.latest} available`));
  el.replaceChildren(...kids);
  // Too long for the widget: drop the quota summaries, the most dispensable part.
  while (el.scrollWidth > el.clientWidth + 1 && el.querySelector('.qm')) [...el.querySelectorAll('.qm')].pop().remove();
}

// ---------------------------------------------------------------- shortcuts
async function runShortcut(btn, id) {
  haptic();
  btn.classList.remove('ok', 'err');
  btn.classList.add('busy');
  let ok = false;
  try { await api('/run/' + encodeURIComponent(id), 'POST', 5000); ok = true; } catch (_) {}
  btn.classList.remove('busy');
  btn.classList.add(ok ? 'ok' : 'err');
  setTimeout(() => btn.classList.remove('ok', 'err'), 900);
}

function keyButton(s) {
  const b = h('button', 'key', h('span', 'k-icon', s.icon || '•'), h('span', 'k-label', s.label));
  b.style.setProperty('--k', s.color || '#6b7280');
  b.addEventListener('click', () => runShortcut(b, s.id));
  return b;
}

// ---------------------------------------------------------------- media (shared state, any number of widgets)
let media = null;          // last media state + the time it was received
let volDragging = false;
const DEFAULT_AMBIENT = '45, 212, 191';

function averageColor(img) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      if (mx < 30 || mx - mn < 20) continue; // skip very dark / grey pixels
      r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++;
    }
    if (!n) return null;
    const [R, G, B] = [r / n, gg / n, b / n];
    const k = 220 / (Math.max(R, G, B) || 1); // normalise brightness
    return [R, G, B].map((v) => Math.round(Math.min(255, v * k))).join(', ');
  } catch (_) { return null; }
}
const setAmbient = (rgb) => document.documentElement.style.setProperty('--ambient', rgb || DEFAULT_AMBIENT);

const MEDIA_HTML = `
  <div class="m-top">
    <div class="art-wrap"><img class="art" alt=""><div class="art-ph">♪</div></div>
    <div class="m-text"><div class="m-app">Media</div><div class="m-title">Nothing playing</div><div class="m-artist">Start something on the PC</div></div>
  </div>
  <div class="m-progress"><div class="bar"><div class="fill"></div></div><div class="times"><span class="m-pos">0:00</span><span class="m-dur">0:00</span></div></div>
  <div class="m-controls">
    <button class="ic" data-media="prev" aria-label="Previous"><svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14L9.5 12z"/></svg></button>
    <button class="ic play" data-media="playpause" aria-label="Play/Pause">
      <svg class="i-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      <svg class="i-pause" viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>
    </button>
    <button class="ic" data-media="next" aria-label="Next"><svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 5v14l10.5-7z"/></svg></button>
    <div class="vol">
      <button class="ic sm mute" aria-label="Mute">
        <svg class="i-vol" viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zm11.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>
        <svg class="i-mute" viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zm12.6 3 2.2-2.2-1.4-1.4-2.2 2.2-2.2-2.2-1.4 1.4 2.2 2.2-2.2 2.2 1.4 1.4 2.2-2.2 2.2 2.2 1.4-1.4z"/></svg>
      </button>
      <input type="range" class="volr" min="0" max="100" step="1" value="50"><span class="vol-val">--</span>
    </div>
  </div>
  <div class="offline-msg"><b>Computer not connected</b>
    <span>Is the PhoneBox agent running? Plug in the USB cable, or turn on Wi-Fi in the PhoneBox settings and pair once over USB.</span></div>`;

// ---------------------------------------------------------------- quotas
const Q_STYLE = { claude: { color: '#d97757', logo: '✳' }, codex: { color: '#e5e7eb', logo: '◎' } };

function fmtReset(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const hm = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  const day = d.toDateString() === new Date().toDateString() ? hm : d.toLocaleDateString(LOCALE, { weekday: 'short' }) + ' ' + hm;
  return `${day} · in ${fmtDur(ts - Date.now())}`;
}

/** Compares the share of the quota used with the share of the window elapsed. */
function paceInfo(l) {
  if (!l.resetsAt || !l.windowSec) return null;
  const win = l.windowSec * 1000;
  const left = l.resetsAt - Date.now();
  const elapsed = Math.min(1, Math.max(0, 1 - left / win));
  if (l.percent >= 100) return { elapsed, cls: 'over', text: 'Limit reached' };
  if (elapsed < 0.04 || l.percent < 1) return { elapsed, cls: 'calm', text: 'Plenty left' };
  const rate = l.percent / (elapsed * win);          // % per ms
  const msTo100 = (100 - l.percent) / rate;
  if (msTo100 < left) return { elapsed, cls: 'over', text: `At this pace: full in ${fmtDur(msTo100)}` };
  const diff = l.percent - elapsed * 100;
  if (diff > 10) return { elapsed, cls: 'fast', text: 'Ahead of pace' };
  if (diff < -10) return { elapsed, cls: 'calm', text: 'Plenty left' };
  return { elapsed, cls: '', text: 'On pace' };
}

// ---------------------------------------------------------------- sessions & GitHub
const S_ORDER = { waiting: 0, busy: 1, shell: 2, idle: 3 };
const prevStatus = new Map();
let workLoaded = false;

/** Vibrates and shows a toast when a session finishes or starts waiting for input. */
function notifyTransitions(sessions) {
  for (const s of sessions) {
    const before = prevStatus.get(s.id);
    if (workLoaded && before && before !== s.status) {
      if (s.status === 'waiting') {
        buzz('0,90,90,90,90,160');
        toast(s.waitingFor || 'needs input', 'err', s.name);
      } else if (s.status === 'idle' && (before === 'busy' || before === 'shell')) {
        buzz('0,70,110,70');
        toast(`${s.name} finished`, 'ok');
      }
    }
    prevStatus.set(s.id, s.status);
  }
  workLoaded = true;
}

function prRow(p, mine) {
  const row = h('div', 'gh-pr' + (p.draft ? ' draft' : ''));
  if (mine) {
    const ciMap = { SUCCESS: '✓', FAILURE: '✗', ERROR: '✗', PENDING: '●', EXPECTED: '●' };
    row.appendChild(h('span', 'ci ' + (p.ci || 'none'), ciMap[p.ci] || '–'));
  } else {
    row.appendChild(h('span', 'ci none', '◇'));
  }
  row.append(h('span', 'rp', `${p.repo.split('/')[1]}#${p.number}`), h('span', 'tt', p.title));
  if (mine && (p.review === 'APPROVED' || p.review === 'CHANGES_REQUESTED'))
    row.appendChild(h('span', 'rv ' + p.review, p.review === 'APPROVED' ? 'approved' : 'changes'));
  return row;
}

// ---------------------------------------------------------------- processes: instance sheet
function monogramColor(name) {
  let x = 0;
  for (const ch of name) x = (x * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${x} 70% 65%)`;
}

/** Fills an icon box with the app icon, falling back to a coloured monogram. */
function fillIcon(box, g) {
  box.replaceChildren();
  box.style.background = monogramColor(g.name);
  box.textContent = (g.title || g.name).charAt(0).toUpperCase();
  if (g.hasIcon !== false) {
    const img = new Image();
    img.onload = () => { box.textContent = ''; box.style.background = 'transparent'; box.appendChild(img); };
    img.src = `${API}/procs/icon?name=${encodeURIComponent(g.name)}`;
  }
}

let sheet = null;   // { group, detail, canKill }

/** Two-tap confirmation: the first tap arms the button, the second one runs the action. */
function armButton(btn, armedText, action) {
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (btn.disabled) return;
    if (!btn.classList.contains('armed')) {
      haptic();
      btn.dataset.text = btn.textContent;
      btn.textContent = armedText;
      btn.classList.add('armed');
      clearTimeout(btn._t);
      btn._t = setTimeout(() => { btn.classList.remove('armed'); btn.textContent = btn.dataset.text; }, 3500);
      return;
    }
    clearTimeout(btn._t);
    btn.classList.remove('armed');
    action();
  });
}

function openSheet(g, canKill) {
  sheet = { group: g, detail: null, canKill };
  fillIcon($('psIco'), g);
  $('psTitle').textContent = g.title;
  $('psSub').textContent = 'Loading…';
  $('psList').replaceChildren();
  $('pSheet').hidden = false;
  loadSheet();
}

function closeSheet() {
  sheet = null;
  $('pSheet').hidden = true;
}

async function loadSheet() {
  if (!sheet) return;
  try {
    const d = await api('/procs/detail?name=' + encodeURIComponent(sheet.group.name));
    if (!sheet || d.name !== sheet.group.name) return;
    sheet.detail = d;
    renderSheet();
  } catch (_) {}
}

function renderSheet() {
  const d = sheet.detail, canKill = sheet.canKill;
  const totalCpu = d.instances.reduce((a, i) => a + i.cpu, 0), totalMem = d.instances.reduce((a, i) => a + i.memMb, 0);
  $('psSub').textContent = `${d.instances.length} instance${d.instances.length === 1 ? '' : 's'} · CPU ${totalCpu.toFixed(1)}% · ${fmtMem(totalMem)}` +
    (d.locked ? ' · system process' : !canKill ? ' · ending disabled in settings' : '');
  const all = $('psAll');
  if (!all.classList.contains('armed')) all.textContent = d.instances.length > 1 ? `End all ${d.instances.length}` : 'End';
  all.disabled = d.locked || !canKill || !d.instances.length;

  const list = $('psList');
  list.replaceChildren();
  if (!d.instances.length) { list.appendChild(h('div', 'empty', 'No running instances')); return; }
  for (const i of d.instances) {
    const primary = i.session ? '✳ ' + i.session : i.window || i.args || d.title;
    const secondary = [i.session ? i.args : i.window ? i.args : null,
      i.startedAt ? (Date.now() - i.startedAt < 60_000 ? 'just started' : 'started ' + shortDur(Date.now() - i.startedAt) + ' ago') : null]
      .filter(Boolean).join(' · ');
    const btn = h('button', 'ps-btn danger', 'End');
    btn.disabled = i.locked || !canKill;
    armButton(btn, 'Confirm', () => killInstance(i, primary));
    list.appendChild(h('div', 'pi', h('span', 'pid', 'PID ' + i.pid),
      h('div', 'lbl', h('b', i.session ? 'sess' : '', primary), h('small', null, secondary)),
      h('div', 'num', h('b', null, i.cpu.toFixed(1) + '%'), h('br'), fmtMem(i.memMb)), btn));
  }
}

async function postKill(query) {
  const r = await fetch(`${API}/procs/kill?${query}`, { method: 'POST', cache: 'no-store' });
  return { ok: r.ok, body: await r.json().catch(() => ({})) };
}

async function killInstance(i, label) {
  try {
    const { ok, body } = await postKill('pid=' + i.pid);
    ok ? toast(`Ended ${label} (PID ${i.pid})`, 'ok') : toast(body.error || 'Could not end it', 'err');
  } catch (_) { toast('Computer unreachable', 'err'); }
  setTimeout(() => { loadSheet(); loadProcs(); }, 500);
}

armButton($('psAll'), 'Tap again to confirm', async () => {
  const g = sheet?.group;
  if (!g) return;
  try {
    const { ok, body } = await postKill('name=' + encodeURIComponent(g.name));
    if (ok) { toast(`Ended ${body.killed} × ${g.title}${body.failed ? ` (${body.failed} failed)` : ''}`, 'ok'); closeSheet(); }
    else toast(body.error || 'Could not end them', 'err');
  } catch (_) { toast('Computer unreachable', 'err'); }
  setTimeout(loadProcs, 500);
});
$('psClose').addEventListener('click', () => { haptic(); closeSheet(); });

// ---------------------------------------------------------------- pushed data (webhook API)
/** Normalises whatever was pushed into { value, title, sub, unit, color, icon, progress, items, level }. */
function pushView(item) {
  const d = item.data;
  const v = { at: item.at };
  if (Array.isArray(d)) v.items = d;
  else if (d !== null && typeof d === 'object') {
    v.value = d.value ?? d.state ?? d.status;
    v.title = d.title ?? d.label ?? d.name;
    v.sub = d.sub ?? d.subtitle ?? d.text ?? d.message;
    v.unit = d.unit;
    v.color = d.color;
    v.icon = d.icon;
    v.items = Array.isArray(d.items) ? d.items : undefined;
    v.level = d.level;
    if (typeof d.progress === 'number') v.progress = d.progress > 1 ? d.progress / 100 : d.progress;
    if (typeof d.min === 'number') v.min = d.min;
    if (typeof d.max === 'number') v.max = d.max;
    if (v.value === undefined && !v.items && v.sub === undefined) v.value = JSON.stringify(d);
  } else v.value = d;
  return v;
}

function fmtValue(x) {
  if (typeof x === 'number') return Math.abs(x) >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10);
  if (typeof x === 'boolean') return x ? 'On' : 'Off';
  return x == null ? '—' : String(x);
}
const LEVEL_COLOR = { ok: '#22c55e', success: '#22c55e', warn: '#f59e0b', warning: '#f59e0b', error: '#ef4444', fail: '#ef4444', failure: '#ef4444', info: '#60a5fa' };
const levelOf = (v) => v.level || (typeof v.value === 'string' ? (/^(ok|pass(ed)?|success|green|up|online)$/i.test(v.value) ? 'ok'
  : /^(fail(ed|ure)?|error|red|down|offline|broken)$/i.test(v.value) ? 'error' : /^(running|pending|building|warn(ing)?|yellow)$/i.test(v.value) ? 'warn' : '') : '');

// ---------------------------------------------------------------- notifications (POST /api/notify)
function handleNotify(d) {
  const level = d.level === 'error' ? 'err' : d.level === 'ok' || d.level === 'success' ? 'ok' : d.level === 'warn' ? 'warn' : '';
  if (d.wake && nightOn) { wakeUntil = Date.now() + 30_000; setNight(false); }
  toast(d.text || '', level, d.title || '', d.seconds || 5);
  if (d.vibrate !== false) buzz(level === 'err' ? '0,90,90,90,90,160' : '0,70,110,70');
  D.notes.unshift({ title: d.title || '', text: d.text || '', level: d.level || 'info', at: Date.now() });
  D.notes = D.notes.slice(0, 30);
  store.set('notes', D.notes);
  emit('notes');
  if (d.page != null) gotoPageRef(d.page);
}

// ---------------------------------------------------------------- permission prompts (Claude Code hook → phone)
let approvals = [];
let approvalShown = null;

async function loadApprovals() {
  if (PREVIEW) return; // permission prompts are answered on the phone, not in the preview
  try { approvals = (await api('/approvals')).items || []; } catch (_) { return; }
  renderApproval();
}

function renderApproval() {
  const a = approvals[0];
  const box = $('approval');
  if (!a) { box.hidden = true; approvalShown = null; return; }
  if (approvalShown !== a.id) {
    approvalShown = a.id;
    lastTouch = Date.now();
    if (nightOn) { wakeUntil = Date.now() + 60_000; setNight(false); }
    buzz('0,120,80,120,80,240');
    $('apAllow').disabled = $('apDeny').disabled = false;
  }
  $('apSource').textContent = a.source || 'Claude Code';
  $('apProject').textContent = a.project || a.session || '';
  $('apCount').textContent = approvals.length > 1 ? `1 of ${approvals.length}` : '';
  $('apTool').textContent = a.tool;
  $('apDesc').textContent = a.description || '';
  $('apDetail').textContent = a.detail || '';
  $('apDetail').hidden = !a.detail;
  box.hidden = false;
  tickApproval();
}

function tickApproval() {
  const a = approvals[0];
  if (!a || $('approval').hidden) return;
  const left = a.expiresAt - Date.now();
  $('apTime').textContent = left > 0 ? `otherwise asked in the terminal in ${fmtTime(left)}` : 'asking in the terminal…';
  if (left < -3000) { approvals.shift(); renderApproval(); }
}
setInterval(tickApproval, 1000);

async function decide(decision) {
  const a = approvals[0];
  if (!a) return;
  haptic();
  $('apAllow').disabled = $('apDeny').disabled = true;
  try {
    await api(`/approvals/${encodeURIComponent(a.id)}?decision=${decision}`, 'POST', 4000);
    toast(`${decision === 'allow' ? 'Allowed' : 'Denied'}: ${a.tool}`, decision === 'allow' ? 'ok' : 'err');
  } catch (_) { toast('Already answered in the terminal', 'warn'); }
  approvals = approvals.filter((x) => x.id !== a.id);
  renderApproval();
}
$('apAllow').addEventListener('click', () => decide('allow'));
$('apDeny').addEventListener('click', () => decide('deny'));

function handleEvent(e) {
  if (PREVIEW && (e.kind === 'goto' || e.kind === 'back' || e.kind === 'reload')) return; // the editor picks the page
  if (e.kind === 'approval' || e.kind === 'approval-done') loadApprovals();
  else if (e.kind === 'notify' && e.data) handleNotify(e.data);
  else if (e.kind === 'goto' && e.data) ruleGoto(e.data);
  else if (e.kind === 'back' && e.data) { if (ruleHold && ruleHold.rule === e.data.rule) endHold(); }
  else if (e.kind === 'refresh') { loadConfig(); loadQuotas(); loadWork(); loadPush(); loadWeather(true); }
  else if (e.kind === 'reload') location.reload();
}

// ================================================================= widgets
// Each widget: { needs: [data kinds], bare?: no card background, create(box, ctx) -> { update(kind) } }
// Data kinds: tick (every second), fast (4×/s), state, weather, quotas, work, procs, push, notes.
const W = {};

W.clock = {
  bare: true, needs: ['tick', 'state', 'weather', 'quotas', 'work'],
  create(box, { o }) {
    const status = o.status !== false ? h('div', 'status') : null;
    const hh = h('span', 'hh', '--'), mm = h('span', 'mm', '--'), ss = h('span', 'sec');
    const date = o.date !== false ? h('div', 'date') : null;
    const wx = o.weather !== false ? wxBlock() : null;
    box.append(status || '', h('div', 'clock', hh, h('span', 'colon', ':'), mm, ss), date || '', wx || '');
    box.style.setProperty('--tf', (0.84 - (status ? 0.1 : 0) - (date ? 0.11 : 0) - (wx ? 0.2 : 0)).toFixed(2));
    return {
      update(kind) {
        if (kind === 'tick') {
          const now = new Date();
          hh.textContent = pad(now.getHours());
          mm.textContent = pad(now.getMinutes());
          ss.textContent = cfg.display?.showSeconds === false ? '' : pad(now.getSeconds());
          if (date) date.textContent = now.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
          if (status && now.getSeconds() % 30 === 0) renderStatus(status); // battery
        } else if (kind === 'weather') wx?.update();
        else if (status) renderStatus(status);
      },
    };
  },
};

W.weather = {
  needs: ['weather'],
  create(box) {
    const wx = wxBlock();
    box.append(wx);
    return { update: () => wx.update() };
  },
};

W.forecast = {
  needs: ['weather'],
  create(box, { o }) {
    const daily = o.mode === 'daily';
    const row = h('div', 'fc');
    box.append(h('div', 'w-title', daily ? '7-day forecast' : 'Next hours', h('span', 'w-sub', '')), row);
    return {
      update() {
        const w = D.weather;
        if (!w?.hourly || !w?.daily) { row.replaceChildren(h('div', 'empty', D.weather === null ? 'Loading…' : 'Weather unavailable')); return; }
        box.querySelector('.w-sub').textContent = cfg.weather?.city || '';
        const vertical = box.clientHeight > box.clientWidth * 0.9;
        const room = vertical ? box.clientHeight - 30 : box.clientWidth - 16;
        const n = Math.max(3, Math.min(daily ? 7 : 12, Math.floor(room / (vertical ? 30 : 50))));
        row.classList.toggle('vert', vertical);
        const cells = [];
        if (daily) {
          const d = w.daily;
          for (let i = 0; i < Math.min(n, d.time.length); i++) {
            const day = i === 0 ? 'Today' : new Date(d.time[i] + 'T12:00').toLocaleDateString(LOCALE, { weekday: 'short' });
            const rain = d.precipitation_probability_max?.[i];
            cells.push(h('div', 'fc-i', h('span', 'fc-t', day), h('span', 'fc-ic', wxIcon(d.weather_code[i])),
              h('span', 'fc-v', Math.round(d.temperature_2m_max[i]) + '°', h('small', null, ' ' + Math.round(d.temperature_2m_min[i]) + '°')),
              h('span', 'fc-r', rain >= 20 ? `💧${rain}%` : '')));
          }
        } else {
          const hr = w.hourly;
          let start = hr.time.indexOf((w.current?.time || '').slice(0, 13) + ':00');
          if (start < 0) start = 0;
          const step = n >= 10 ? 1 : 2;
          for (let k = 0; k < n; k++) {
            const i = start + k * step;
            if (i >= hr.time.length) break;
            const rain = hr.precipitation_probability?.[i];
            cells.push(h('div', 'fc-i', h('span', 'fc-t', k === 0 ? 'Now' : hr.time[i].slice(11, 13)), h('span', 'fc-ic', wxIcon(hr.weather_code[i], hr.is_day?.[i])),
              h('span', 'fc-v', Math.round(hr.temperature_2m[i]) + '°'), h('span', 'fc-r', rain >= 20 ? `💧${rain}%` : '')));
          }
        }
        row.replaceChildren(...cells);
      },
    };
  },
};

W.media = {
  needs: ['state', 'fast'],
  create(box) {
    box.innerHTML = MEDIA_HTML;
    const q = (s) => box.querySelector(s);
    const img = q('.art'), vol = q('.volr');
    let artId = -1, volTimer = 0;
    img.addEventListener('load', () => { img.classList.add('on'); setAmbient(averageColor(img)); });
    img.addEventListener('error', () => img.classList.remove('on'));
    box.querySelectorAll('[data-media]').forEach((btn) => btn.addEventListener('click', async () => {
      haptic();
      const action = btn.dataset.media;
      if (action === 'playpause' && media) {
        media.playing = !media.playing; // optimistic update
        media.at = performance.now();
        box.classList.toggle('playing', media.playing);
      }
      try { await api('/media/' + action, 'POST'); } catch (_) {}
    }));
    q('.bar').addEventListener('click', async (e) => {
      if (!media || !media.durMs || !media.canSeek) return;
      const r = e.currentTarget.getBoundingClientRect();
      const ms = Math.round(((e.clientX - r.left) / r.width) * media.durMs);
      haptic();
      media.posMs = ms; media.at = performance.now();
      try { await api('/media/seek?ms=' + ms, 'POST'); } catch (_) {}
    });
    const paintVol = (v) => { vol.style.setProperty('--p', v + '%'); q('.vol-val').textContent = v; };
    vol.addEventListener('input', () => {
      volDragging = true;
      paintVol(vol.value);
      clearTimeout(volTimer);
      volTimer = setTimeout(() => api('/volume?level=' + vol.value, 'POST').catch(() => {}), 120);
    });
    vol.addEventListener('change', () => setTimeout(() => (volDragging = false), 600));
    q('.mute').addEventListener('click', async () => {
      haptic();
      try { const a = await api('/volume?op=mute', 'POST'); D.state && (D.state.audio = a); emit('state'); } catch (_) {}
    });

    return {
      update(kind) {
        if (kind === 'fast') {
          if (!media || !(media.durMs > 0)) return;
          const pos = Math.min(media.durMs, media.posMs + (media.playing ? performance.now() - media.at : 0));
          q('.fill').style.width = (pos / media.durMs) * 100 + '%';
          q('.m-pos').textContent = fmtTime(pos);
          return;
        }
        const m = D.state?.media, a = D.state?.audio;
        if (a) {
          box.classList.toggle('muted-on', !!a.muted);
          if (!volDragging) { vol.value = a.volume; paintVol(a.volume); }
        }
        box.classList.toggle('idle', !m);
        if (!m) {
          box.classList.remove('playing');
          q('.m-app').textContent = 'Media';
          q('.m-title').textContent = 'Nothing playing';
          q('.m-artist').textContent = 'Press ▶ to resume';
          q('.fill').style.width = '0';
          q('.m-pos').textContent = q('.m-dur').textContent = '0:00';
          if (artId !== 0) { artId = 0; img.classList.remove('on'); setAmbient(null); }
          return;
        }
        box.classList.toggle('playing', m.playing);
        q('.m-app').textContent = m.app || 'Media';
        q('.m-title').textContent = m.title || 'Unknown track';
        q('.m-artist').textContent = [m.artist, m.album].filter(Boolean).join(' · ') || '—';
        q('.m-dur').textContent = fmtTime(m.durMs);
        if (m.artId !== artId) {
          artId = m.artId;
          if (m.artId) img.src = `${API}/art?id=${m.artId}`;
          else { img.classList.remove('on'); setAmbient(null); }
        }
      },
    };
  },
};

W.stat = {
  needs: ['state'],
  create(box, { o }) {
    const m = METRICS[o.metric] || METRICS.cpu;
    const c = color(m.color);
    box.style.setProperty('--c', c);
    const canvas = h('canvas');
    const val = h('b', null, '—'), unit = h('small'), sub = h('div', 't-sub', ' ');
    box.append(canvas, h('div', 't-label', m.label), h('div', 't-val', val, unit), sub);
    return {
      update() {
        const s = D.state;
        if (!s) return;
        const [v, u] = metricText(m, s);
        val.textContent = v;
        unit.textContent = u;
        sub.textContent = m.sub?.(s) || ' ';
        chart(canvas, [{ data: hist[m.hist || o.metric] || hist.cpu, color: c, max: m.max(s) }]);
      },
    };
  },
};

W.gauge = {
  needs: ['state'],
  create(box, { o }) {
    const m = METRICS[o.metric] || METRICS.cpu;
    box.style.setProperty('--q', color(m.color));
    const dial = h('div', 'g-dial'), pct = h('div', 'g-val'), sub = h('div', 'g-sub');
    box.append(dial, h('div', 'g-label', m.label), sub);
    dial.append(pct);
    let svg = null;
    return {
      update() {
        const s = D.state;
        if (!s) return;
        const raw = m.pct ? m.pct(s) : m.val(s);
        const p = raw == null ? 0 : (raw / (m.pct ? 100 : m.max(s))) * 100;
        const warn = o.metric.includes('temp') ? (raw > 85 ? '#ef4444' : raw > 75 ? '#f59e0b' : '') : (p >= 95 ? '#ef4444' : p >= 85 ? '#f59e0b' : '');
        dial.style.setProperty('--qc', warn || 'var(--q)');
        if (svg) svg.remove();
        dial.insertAdjacentHTML('afterbegin', ringSvg(p));
        svg = dial.firstElementChild;
        const [v, u] = metricText(m, s);
        pct.replaceChildren(v, h('small', null, u));
        sub.textContent = m.sub?.(s) || '';
      },
    };
  },
};

W.chart = {
  needs: ['state'],
  create(box, { o }) {
    const keys = (Array.isArray(o.metrics) && o.metrics.length ? o.metrics : ['cpu']).filter((k) => METRICS[k]);
    const single = keys.length === 1 ? METRICS[keys[0]] : null;
    const isNet = keys.every((k) => k === 'down' || k === 'up');
    const label = single ? single.name : isNet ? 'Network' : keys.map((k) => METRICS[k].name).join(' · ');
    box.style.setProperty('--c', color((single || METRICS[keys[0]]).color));
    const head = h('div', 's-head', h('span', 's-label', label), h('span', 's-name', ''));
    const main = h('div', 's-main');
    const canvas = h('canvas');
    box.append(head, main, canvas);
    return {
      update() {
        const s = D.state;
        if (!s) return;
        if (single) {
          const [v, u] = metricText(single, s);
          main.replaceChildren(h('b', null, v), h('small', null, u), h('span', 'chips', single.sub?.(s) ? h('span', 'chip', single.sub(s)) : ''));
          head.lastChild.textContent = single.title?.(s) || '';
        } else {
          main.replaceChildren(...keys.map((k) => {
            const mm = METRICS[k];
            const [v, u] = metricText(mm, s);
            const e = h('span', 'multi', (k === 'down' ? '↓ ' : k === 'up' ? '↑ ' : mm.label + ' '), h('b', null, v + ' ' + u));
            e.style.color = color(mm.color);
            return e;
          }));
          head.lastChild.textContent = isNet && s.ping ? `Ping ${s.ping.ms != null ? Math.round(s.ping.ms) + ' ms' : '—'} · loss ${s.ping.lossPct}%` : '';
        }
        chart(canvas, keys.map((k) => ({ data: hist[METRICS[k].hist || k], color: color(METRICS[k].color), max: METRICS[k].max(s) })), { grid: true });
      },
    };
  },
};

W.meters = {
  needs: ['state'],
  create(box) {
    box.style.setProperty('--c', cssVar('--ram'));
    const up = h('span', 's-name');
    const list = h('div', 'meters');
    box.append(h('div', 's-head', h('span', 's-label', 'Memory'), up), list);
    const meter = (name, txt, pct, c) => {
      const e = h('div', 'meter', h('div', 'm-row', h('span', null, name), h('span', null, txt)), h('div', 'track', h('i')));
      e.querySelector('i').style.width = Math.min(100, pct) + '%';
      if (c) e.style.setProperty('--c', c);
      return e;
    };
    return {
      update() {
        const pc = D.state?.pc;
        if (!pc) return;
        const s = pc.uptimeSec, d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
        up.textContent = 'Up ' + (d ? `${d} d ${hr} h` : hr ? `${hr} h ${m} min` : `${m} min`);
        const rows = [meter('RAM', `${r1(pc.ramUsedGb)} / ${Math.round(pc.ramTotalGb)} GB`, (pc.ramUsedGb / pc.ramTotalGb) * 100)];
        const g = pc.gpu;
        if (g && g.vramTotal) rows.push(meter('VRAM', `${r1(g.vramUsed)} / ${Math.round(g.vramTotal)} GB`, (g.vramUsed / g.vramTotal) * 100, cssVar('--gpu')));
        const disks = h('div', 'disks', ...(pc.disks || []).map((dk) => meter(dk.name, Math.round((dk.usedGb / dk.totalGb) * 100) + '%', (dk.usedGb / dk.totalGb) * 100, '#94a3b8')));
        list.replaceChildren(...rows, disks);
      },
    };
  },
};

W.quotas = {
  needs: ['quotas', 'tick'],
  create(box, { o }) {
    const want = Array.isArray(o.providers) ? o.providers : ['claude', 'codex'];
    const grid = h('div', 'q-grid', h('div', 'empty', 'Quota data arrives once the computer is connected.'));
    box.append(grid);
    let last = 0;
    const render = () => {
      if (!D.quotas) return;
      const list = quotaProviders().filter((p) => want.includes(p.id));
      grid.replaceChildren();
      if (!list.length) { grid.appendChild(h('div', 'empty', 'No quota providers enabled')); return; }
      for (const p of list) {
        const st = Q_STYLE[p.id] || { color: '#94a3b8', logo: '●' };
        const card = h('div', 'q-card');
        card.style.setProperty('--q', st.color);
        card.style.flex = String(Math.max(1, p.limits.length) + 0.3);
        card.appendChild(h('div', 'q-head', h('span', 'q-logo', st.logo), h('span', 'q-name', p.name), h('span', 'q-plan', p.plan),
          p.updatedAt ? h('span', 'q-upd', fmtDur(Date.now() - p.updatedAt) + ' ago') : null));
        const rings = h('div', 'q-rings');
        for (const l of p.limits) {
          const pace = paceInfo(l);
          const dial = h('div', 'q-dial');
          if (l.percent >= 95 || l.severity === 'critical') dial.style.setProperty('--qc', '#ef4444');
          else if (l.percent >= 80 || l.severity === 'warning') dial.style.setProperty('--qc', '#f59e0b');
          dial.innerHTML = ringSvg(l.percent, pace?.elapsed); // numbers only
          dial.appendChild(h('div', 'q-pct', String(Math.round(l.percent)), h('small', null, '%')));
          rings.appendChild(h('div', 'q-ring', dial, h('div', 'q-label', l.label), h('div', 'q-reset', fmtReset(l.resetsAt)),
            pace ? h('div', 'q-pace ' + pace.cls, pace.text) : null));
        }
        if (!p.limits.length) rings.appendChild(h('div', 'q-reset', 'No data'));
        card.append(rings, h('div', 'q-foot', h('span', null, p.extra || ''), p.error ? h('span', 'q-err', p.error) : h('span')));
        grid.appendChild(card);
      }
    };
    return {
      update(kind) {
        if (kind === 'tick') { if (Date.now() - last > 30_000) { last = Date.now(); render(); } return; }
        last = Date.now();
        render();
      },
    };
  },
};

W.sessions = {
  needs: ['work'],
  create(box) {
    const sum = h('span', 'w-sum');
    const list = h('div', 's-list', h('div', 'empty', 'Waiting for session data…'));
    box.append(h('div', 'w-head', h('span', 's-label', 'Sessions'), sum), list);
    box.style.setProperty('--c', '#d97757');
    return {
      update() {
        const sessions = D.work?.sessions;
        if (!sessions) return;
        const counts = { waiting: 0, busy: 0, shell: 0, idle: 0 };
        sessions.forEach((s) => (counts[s.status] = (counts[s.status] || 0) + 1));
        sum.textContent = [
          counts.busy + counts.shell ? `${counts.busy + counts.shell} working` : '',
          counts.waiting ? `${counts.waiting} waiting` : '',
          counts.idle ? `${counts.idle} idle` : '',
        ].filter(Boolean).join(' · ') || 'No open sessions';
        const sorted = [...sessions].sort((a, b) => (S_ORDER[a.status] ?? 9) - (S_ORDER[b.status] ?? 9) || b.since - a.since);
        list.replaceChildren(...(sorted.length ? sorted.map((s) => h('div', 'sess ' + s.status,
          h('span', 'st'), h('span', 'tl ' + s.tool, s.tool === 'claude' ? '✳' : '◎'), h('span', 'nm', s.name),
          h('span', 'ds', (s.status === 'waiting' ? 'waiting · ' : '') + shortDur(Date.now() - s.since))))
          : [h('div', 'empty', 'No Claude Code / Codex sessions open')]));
      },
    };
  },
};

W.github = {
  needs: ['work'],
  create(box) {
    box.style.setProperty('--c', '#c9d1d9');
    const user = h('span', 'w-sum'), bell = h('span', 'gh-bell');
    const rc = h('b'), mc = h('b'), rev = h('div', 'gh-list'), mine = h('div', 'gh-list'), err = h('div', 'gh-err', 'Waiting for GitHub data…');
    box.append(h('div', 'w-head', h('span', 's-label', 'GitHub'), user, bell),
      h('div', 'gh-sec', h('span', null, 'Review requests'), rc), rev,
      h('div', 'gh-sec', h('span', null, 'My pull requests'), mc), mine, err);
    return {
      update() {
        const g = D.work?.github;
        if (!g) return;
        const rows = Math.max(1, Math.floor((box.clientHeight - 90) / 25));
        user.textContent = g.user ? '@' + g.user : '';
        bell.textContent = `🔔 ${g.notifications >= 50 ? '50+' : g.notifications}`;
        rc.textContent = g.reviewRequests.length;
        mc.textContent = g.myPrs.length;
        const nRev = Math.min(g.reviewRequests.length || 1, Math.max(1, Math.floor(rows / 2)));
        rev.replaceChildren(...(g.reviewRequests.length ? g.reviewRequests.slice(0, nRev).map((p) => prRow(p, false)) : [h('div', 'gh-pr', 'No pending reviews')]));
        mine.replaceChildren(...(g.myPrs.length ? g.myPrs.slice(0, Math.max(1, rows - nRev)).map((p) => prRow(p, true)) : [h('div', 'gh-pr', 'No open pull requests')]));
        err.textContent = g.error ? 'GitHub: ' + g.error : '';
      },
    };
  },
};

W.processes = {
  needs: ['procs'],
  create(box, { o }) {
    const canKill = o.allowKill !== false;
    let sort = 'cpu';
    const sum = h('span', 'p-sum');
    const seg = h('div', 'seg', h('button', 'on', 'CPU'), h('button', null, 'RAM'));
    const grid = h('div', 'p-grid', h('div', 'empty', 'Processes appear once the computer is connected.'));
    box.style.setProperty('--c', '#f472b6');
    box.append(h('div', 'p-head', h('span', 's-label', 'Processes'), sum, seg), grid);
    const els = new Map();
    const rowEl = (g) => {
      let e = els.get(g.name);
      if (e) return e;
      e = h('div', 'proc');
      e.innerHTML = '<div class="p-ico"></div><div class="p-info"><div class="p-title"><span class="p-t"></span><span class="p-count"></span><span class="p-lock"></span></div>' +
        '<div class="p-bar"><i></i></div></div><div class="p-nums"><b></b><small></small></div>';
      fillIcon(e.querySelector('.p-ico'), g);
      e.addEventListener('click', () => { haptic(); openSheet(e._g, canKill); });
      els.set(g.name, e);
      return e;
    };
    const render = () => {
      const data = D.procs;
      if (!data) return;
      if (!data.groups.length) { sum.textContent = ''; grid.replaceChildren(h('div', 'empty', 'Measuring…')); return; }
      const cols = box.clientWidth > 460 ? 2 : 1;
      const rows = Math.max(1, Math.floor((box.clientHeight - 46) / 40));
      grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
      grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
      const list = [...data.groups].sort((a, b) => (sort === 'cpu' ? b.cpu - a.cpu || b.memMb - a.memMb : b.memMb - a.memMb)).slice(0, cols * rows);
      const max = Math.max(0.1, ...list.map((g) => (sort === 'cpu' ? g.cpu : g.memMb)));
      sum.textContent = box.clientWidth > 380 ? `${data.total} processes · ${data.groupCount ?? data.groups.length} apps · tap one for details` : `${data.total} processes`;
      if (grid.querySelector('.empty')) grid.replaceChildren();
      const keep = new Set(list.map((g) => g.name));
      for (const [n, e] of els) if (!keep.has(n)) { e.remove(); els.delete(n); }
      for (const g of list) {
        const e = rowEl(g);
        e._g = g;
        e.querySelector('.p-t').textContent = g.title;
        e.querySelector('.p-count').textContent = g.count > 1 ? '×' + g.count : '';
        e.querySelector('.p-lock').textContent = g.locked ? '🔒' : '';
        e.querySelector('.p-bar i').style.width = ((sort === 'cpu' ? g.cpu : g.memMb) / max) * 100 + '%';
        e.querySelector('.p-nums b').textContent = sort === 'cpu' ? g.cpu.toFixed(1) + '%' : fmtMem(g.memMb);
        e.querySelector('.p-nums small').textContent = sort === 'cpu' ? fmtMem(g.memMb) : g.cpu.toFixed(1) + '%';
        grid.appendChild(e); // keeps the order
      }
    };
    [...seg.children].forEach((b, i) => b.addEventListener('click', () => {
      haptic();
      sort = i === 0 ? 'cpu' : 'mem';
      [...seg.children].forEach((x) => x.classList.toggle('on', x === b));
      render();
    }));
    return { update: render };
  },
};

W.shortcuts = {
  needs: [],
  create(box, { o }) {
    const all = cfg.shortcuts || [];
    const ids = Array.isArray(o.ids) && o.ids.length ? o.ids : null;
    const list = ids ? ids.map((id) => all.find((s) => s.id === id)).filter(Boolean) : all;
    if (!list.length) {
      box.append(h('div', 'empty', all.length ? 'None of the chosen shortcuts exist any more.' : 'Shortcuts load once the computer is connected.\nEdit them from the tray icon › Settings.'));
      return {};
    }
    const cols = Math.min(8, Math.max(1, o.columns || 4));
    const grid = h('div', 'deck-grid', ...list.map(keyButton));
    grid.style.gridTemplateColumns = `repeat(${Math.min(cols, list.length)}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${Math.ceil(list.length / cols)}, 1fr)`;
    box.append(grid);
    return {};
  },
};

W.button = {
  bare: true, needs: [],
  create(box, { o }) {
    const s = (cfg.shortcuts || []).find((x) => x.id === o.id) || (cfg.shortcuts || [])[0];
    box.append(s ? keyButton(s) : h('div', 'empty', 'Pick a shortcut in the settings'));
    return {};
  },
};

W.worldclock = {
  needs: ['tick'],
  create(box, { o }) {
    const zones = (Array.isArray(o.zones) && o.zones.length ? o.zones : ['Tallinn=Europe/Tallinn', 'Istanbul=Europe/Istanbul', 'London=Europe/London', 'New York=America/New_York', 'Tokyo=Asia/Tokyo'])
      .map((z) => { const i = z.indexOf('='); return i > 0 ? [z.slice(0, i).trim(), z.slice(i + 1).trim()] : [z.split('/').pop().replace(/_/g, ' '), z.trim()]; });
    const items = zones.map(([name, tz]) => {
      let fmt = null;
      try { fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch (_) {}
      const t = h('div', 'wc-t', fmt ? '--:--' : '??'), s = h('div', 'wc-s', fmt ? '' : 'unknown zone');
      return { fmt, t, s, el: h('div', 'wc', h('div', 'wc-n', name), t, s) };
    });
    const row = h('div', 'wc-row', items.map((i) => i.el));
    box.append(row);
    return {
      update() {
        if (new Date().getSeconds() !== 0 && items[0]?.t.textContent !== '--:--') return;
        const now = new Date();
        const localUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());
        row.classList.toggle('vert', box.clientHeight > box.clientWidth * 1.1);
        for (const it of items) {
          if (!it.fmt) continue;
          const p = Object.fromEntries(it.fmt.formatToParts(now).map((x) => [x.type, x.value]));
          it.t.textContent = `${p.hour}:${p.minute}`;
          const zoneUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
          const diffH = Math.round((zoneUtc - localUtc) / 360000) / 10;
          const dayDiff = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
          const day = dayDiff > 0 ? 'Tomorrow' : dayDiff < 0 ? 'Yesterday' : 'Today';
          it.s.textContent = diffH === 0 ? day : `${day}, ${diffH > 0 ? '+' : '−'}${Math.abs(diffH)}h`;
        }
      },
    };
  },
};

W.calendar = {
  needs: ['tick'],
  create(box) {
    let shown = '';
    return {
      update() {
        const now = new Date();
        const key = now.toDateString();
        if (key === shown) return;
        shown = key;
        const y = now.getFullYear(), m = now.getMonth();
        const first = new Date(y, m, 1), days = new Date(y, m + 1, 0).getDate();
        const lead = (first.getDay() + 6) % 7; // Monday first
        const cells = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => h('span', 'cal-h' + (i > 4 ? ' we' : ''), d));
        const prevDays = new Date(y, m, 0).getDate();
        for (let i = 0; i < lead; i++) cells.push(h('span', 'cal-d out', prevDays - lead + 1 + i));
        for (let d = 1; d <= days; d++) {
          const wd = (lead + d - 1) % 7;
          cells.push(h('span', 'cal-d' + (d === now.getDate() ? ' today' : '') + (wd > 4 ? ' we' : ''), d));
        }
        const total = Math.ceil(cells.length / 7) * 7;
        for (let d = 1; cells.length < total; d++) cells.push(h('span', 'cal-d out', d));
        const grid = h('div', 'cal', cells);
        grid.style.gridTemplateRows = `auto repeat(${total / 7 - 1}, 1fr)`;
        box.replaceChildren(h('div', 'w-title', now.toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' }),
          h('span', 'w-sub', 'Week ' + isoWeek(now))), grid);
      },
    };
  },
};

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
}

W.pomodoro = {
  needs: ['tick'],
  create(box, { o, page, w }) {
    const key = `pomo:${page.id}/${w.id}`;
    const focusMs = Math.max(1, o.focus || 25) * 60_000, breakMs = Math.max(1, o.break || 5) * 60_000;
    const today = new Date().toDateString();
    let st = store.get(key, null);
    if (!st || typeof st !== 'object') st = { phase: 'focus', endsAt: null, left: focusMs, count: 0, day: today };
    if (st.day !== today) { st.count = 0; st.day = today; }
    const save = () => store.set(key, st);
    const dial = h('div', 'g-dial'), time = h('div', 'g-val'), phase = h('div', 'g-label'), count = h('div', 'g-sub');
    const play = h('button', 'pb main', '▶'), reset = h('button', 'pb', '↺'), skip = h('button', 'pb', '⏭');
    dial.append(time);
    box.append(dial, phase, count, h('div', 'pomo-btns', reset, play, skip));
    let svg = null;
    const total = () => (st.phase === 'focus' ? focusMs : breakMs);
    const remaining = () => (st.endsAt ? Math.max(0, st.endsAt - Date.now()) : st.left);
    const switchPhase = (manual) => {
      if (st.phase === 'focus' && !manual) st.count++;
      st.phase = st.phase === 'focus' ? 'break' : 'focus';
      st.left = total();
      st.endsAt = manual ? null : Date.now() + st.left;
      save();
    };
    const render = () => {
      if (st.endsAt && remaining() <= 0) {
        const wasFocus = st.phase === 'focus';
        switchPhase(false);
        buzz('0,200,120,200,120,400');
        toast(wasFocus ? 'Time for a break' : 'Back to focus', 'ok', '🍅 Pomodoro', 5);
      }
      const left = remaining();
      box.classList.toggle('brk', st.phase === 'break');
      box.classList.toggle('run', !!st.endsAt);
      if (svg) svg.remove();
      dial.insertAdjacentHTML('afterbegin', ringSvg(100 * (1 - left / total())));
      svg = dial.firstElementChild;
      time.textContent = fmtTime(left + 999);
      phase.textContent = st.phase === 'focus' ? 'Focus' : 'Break';
      count.textContent = st.count ? '🍅'.repeat(Math.min(st.count, 6)) + (st.count > 6 ? ` ×${st.count}` : '') : 'No sessions yet today';
      play.textContent = st.endsAt ? '⏸' : '▶';
    };
    play.addEventListener('click', () => {
      haptic();
      if (st.endsAt) { st.left = remaining(); st.endsAt = null; } else st.endsAt = Date.now() + st.left;
      save(); render();
    });
    reset.addEventListener('click', () => { haptic(); st.endsAt = null; st.left = total(); save(); render(); });
    skip.addEventListener('click', () => { haptic(); switchPhase(true); render(); });
    return { update: render };
  },
};

W.countdown = {
  needs: ['tick'],
  create(box, { o }) {
    const m = String(o.target || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
    const target = m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime() : NaN;
    const big = h('div', 'cd-v'), sub = h('div', 'cd-s');
    box.append(h('div', 'cd-l', o.label || 'Countdown'), big, sub);
    if (Number.isNaN(target)) { big.textContent = '—'; sub.textContent = 'Set a date as YYYY-MM-DD HH:MM'; return {}; }
    sub.textContent = new Date(target).toLocaleString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    return {
      update() {
        let d = target - Date.now();
        const past = d < 0;
        d = Math.abs(d);
        const days = Math.floor(d / 86400000), hrs = Math.floor((d % 86400000) / 3600000), mins = Math.floor((d % 3600000) / 60000), secs = Math.floor((d % 60000) / 1000);
        big.textContent = (past ? '+' : '') + (days ? `${days}d ${hrs}h` : hrs ? `${hrs}h ${pad(mins)}m` : `${mins}:${pad(secs)}`);
        box.classList.toggle('past', past);
      },
    };
  },
};

W.note = {
  bare: true, needs: [],
  create(box, { o }) {
    const text = String(o.text ?? '');
    box.style.setProperty('--n', o.color || '#fbbf24');
    box.style.setProperty('--nf', text.length < 25 ? 15 : text.length < 70 ? 10.5 : text.length < 160 ? 8 : 6.5);
    box.append(h('div', 'note-t', text));
    return {};
  },
};

W.label = {
  bare: true, needs: [],
  create(box, { o }) {
    box.append(h('div', 'lbl-t', o.text || ''));
    return {};
  },
};

W.command = {
  needs: ['tick'],
  create(box, { o, page, w }) {
    const out = h('div', 'cmd-o', '…'), foot = h('div', 'cmd-f', '');
    box.append(h('div', 'w-title', o.title || 'Command'), out, foot);
    let last = 0, busy = false, res = null;
    const load = async (force) => {
      if (busy) return;
      busy = true;
      try {
        res = await api(`/widget/${encodeURIComponent(page.id)}/${encodeURIComponent(w.id)}${force ? '?force=true' : ''}`, 'GET', 4000);
        const text = res.output ?? '';
        out.textContent = text || (res.running ? 'Running…' : '(no output)');
        const short = text.length <= 14 && !text.includes('\n');
        out.classList.toggle('big', short);
        box.classList.toggle('bad', res.ok === false);
      } catch (_) { if (!res) out.textContent = online ? 'Unavailable' : '—'; }
      busy = false;
    };
    box.addEventListener('click', () => { haptic(); last = Date.now(); load(true).then(() => setTimeout(() => load(false), 1500)); });
    return {
      update() {
        if (res?.at) foot.textContent = (res.running ? 'refreshing · ' : '') + ago(res.at) + (res.durationMs ? ` · ${Math.round(res.durationMs)} ms` : '');
        if (!online || Date.now() - last < (res?.running || !res?.at ? 2000 : 5000)) return;
        last = Date.now();
        load(false);
      },
    };
  },
};

W.push = {
  needs: ['push', 'tick'],
  create(box, { o }) {
    const key = o.key || '';
    let lastAt = -1;
    const render = () => {
      const item = D.push[key];
      if (!item) {
        if (lastAt === 0) return;
        lastAt = 0;
        box.style.removeProperty('--c');
        box.replaceChildren(h('div', 'w-title', o.title || key), h('div', 'push-empty', 'No data yet', h('code', null, `POST /api/push/${key}`)));
        return;
      }
      const ageEl = box.querySelector('.push-age');
      if (item.at === lastAt) { if (ageEl) ageEl.textContent = ago(item.at); return; }
      lastAt = item.at;
      const v = pushView(item);
      const lvl = levelOf(v);
      const c = v.color || LEVEL_COLOR[lvl] || '';
      if (c) box.style.setProperty('--c', c); else box.style.removeProperty('--c');
      const unit = v.unit ?? o.unit ?? '';
      const style = o.style && o.style !== 'auto' ? o.style : v.items ? 'list' : 'big';
      const title = h('div', 'w-title', (v.icon ? v.icon + ' ' : '') + (o.title || v.title || key), h('span', 'push-age w-sub', ago(item.at)));
      let body;
      if (style === 'list') {
        const items = v.items || (v.value != null ? [v.value] : []);
        body = h('div', 'push-list', items.slice(0, 30).map((x) => {
          if (x && typeof x === 'object') {
            const li = h('div', 'pl-i', h('span', 'pl-l', x.label ?? x.title ?? x.name ?? ''), h('span', 'pl-v', fmtValue(x.value ?? x.status ?? '')));
            const lc = LEVEL_COLOR[x.level || levelOf({ value: x.value ?? x.status })];
            if (lc) li.style.setProperty('--lc', lc);
            return li;
          }
          return h('div', 'pl-i', h('span', 'pl-l', fmtValue(x)));
        }));
      } else if (style === 'gauge') {
        const min = v.min ?? (typeof o.min === 'number' ? o.min : 0), max = v.max ?? (typeof o.max === 'number' ? o.max : 100);
        const num = typeof v.value === 'number' ? v.value : parseFloat(v.value);
        const pct = v.progress != null ? v.progress * 100 : Number.isFinite(num) ? ((num - min) / (max - min || 1)) * 100 : 0;
        const dial = h('div', 'g-dial');
        dial.innerHTML = ringSvg(pct);
        dial.appendChild(h('div', 'g-val', fmtValue(v.value ?? Math.round(pct)), h('small', null, unit)));
        box.style.setProperty('--q', c || 'var(--cpu)');
        body = h('div', 'push-gauge', dial, v.sub ? h('div', 'g-sub', v.sub) : null);
      } else {
        body = h('div', 'push-big', h('div', 'pv', fmtValue(v.value), unit ? h('small', null, unit) : null),
          v.sub ? h('div', 'ps', String(v.sub)) : null,
          v.progress != null ? h('div', 'track', h('i')) : null);
        const bar = body.querySelector('.track i');
        if (bar) bar.style.width = Math.max(0, Math.min(100, v.progress * 100)) + '%';
      }
      box.className = box.className.replace(/\bps-\w+/g, '') + ' ps-' + style;
      box.replaceChildren(title, body);
    };
    return { update: render };
  },
};

// ---------------------------------------------------------------- kripto: KriptoBot/OKX dashboard (push key "kripto")
const kf = (x, d) => {
  if (x == null || !Number.isFinite(+x)) return '—';
  x = +x; const a = Math.abs(x);
  const dd = d ?? (a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6);
  return x.toLocaleString('en-US', { minimumFractionDigits: dd, maximumFractionDigits: dd });
};
const ks = (x, d = 2) => (x == null || !Number.isFinite(+x) ? '—' : (+x >= 0 ? '+' : '−') + kf(Math.abs(+x), d));
const kcls = (x) => (x == null ? '' : +x > 0 ? 'up' : +x < 0 ? 'dn' : '');
const ktime = (ts) => { if (!ts) return ''; const d = new Date(ts); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function kspark(arr, up) {
  const s = h('span', 'kx-sp');
  if (!arr || arr.length < 2) return s;
  const mn = Math.min(...arr), mx = Math.max(...arr), r = mx - mn || 1, n = arr.length - 1;
  const pts = arr.map((v, i) => `${(i / n * 100).toFixed(1)},${(27 - (v - mn) / r * 26).toFixed(1)}`).join(' ');
  const col = up ? 'var(--ok)' : 'var(--err)';
  s.innerHTML = `<svg viewBox="0 0 100 28" preserveAspectRatio="none"><polyline points="0,28 ${pts} 100,28" fill="${col}" fill-opacity=".08" stroke="none"/><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
  return s;
}
const kkpi = (label, val, cls, sub) => h('div', 'kx-kpi', h('div', 'kx-kl', label), h('div', 'kx-kv ' + (cls || ''), val), sub ? h('div', 'kx-ks', sub) : null);
const ksec = (title, extra, rows) => h('div', 'kx-sec', h('div', 'kx-st', title, extra ? h('span', null, extra) : null),
  rows.length ? rows : h('div', 'kx-none', 'Yok'));
const klong = (t) => t === 'long' || t === 'AL' || t === 'buy';
const krow = (l, m, v, cls, side) => h('div', 'kx-r', side ? h('i', 'kx-tag' + (klong(side) ? ' L' : ''), klong(side) ? 'L' : 'S') : h('i'),
  h('span', 'kx-rl', l), h('span', 'kx-rm', m || ''), h('span', 'kx-rv ' + (cls || ''), v));

W.kripto = {
  bare: true, needs: ['push', 'tick'],
  create(box, { o }) {
    const key = o.key || 'kripto';
    let lastAt = -1;
    const render = () => {
      const item = D.push[key];
      if (!item) { if (lastAt !== 0) { lastAt = 0; box.replaceChildren(h('div', 'kx-wait', 'KriptoBot verisi bekleniyor…')); } return; }
      const age = box.querySelector('.kx-age');
      if (item.at === lastAt) { if (age) age.textContent = ago(item.at); return; }
      lastAt = item.at;
      const d = item.data || {}, k = d.kpi || {}, b = d.bot || {}, f = d.funding || {};
      const fund = Object.entries(f).map(([c, r]) => `${c} ${r >= 0 ? '+' : ''}${(+r).toFixed(4)}%`).join('   ');
      const head = h('div', 'kx-head',
        kkpi('OKX equity', kf(k.equity, 2), 'big', k.avail != null ? `boşta ${kf(k.avail, 0)} USDT` : null),
        kkpi('Canlı uPnL', ks(k.upnl), kcls(k.upnl), `bugün ${ks(k.d1)}`),
        kkpi('Realized 7g', ks(k.d7), kcls(k.d7), `30g ${ks(k.d30)}`),
        kkpi('Win rate 30g', k.win != null ? `${(+k.win).toFixed(0)}%` : '—', '', k.n ? `${k.n} işlem` : null),
        kkpi('Kağıt bakiye', kf(k.paperBal, 0), '', `uPnL ${ks(k.paperUpnl)}`),
        kkpi('BTC dominance', k.dom != null ? `${(+k.dom).toFixed(1)}%` : '—', '', null));
      const coins = h('div', 'kx-coins', h('div', 'kx-cg kx-chd', h('span', null, 'Coin'), h('span', null, 'Fiyat'), h('span', null, '24s'), h('span', null, '24 saat')),
        (d.coins || []).map((c) => h('div', 'kx-cg kx-c', h('b', null, c.s), h('span', 'kx-px', kf(c.px)),
          h('span', 'kx-ch24 ' + kcls(c.ch), `${c.ch >= 0 ? '+' : '−'}${Math.abs(c.ch).toFixed(2)}%`), kspark(c.spark, c.ch >= 0))));
      const pos = (d.pos || []).map((p) => krow(`${p.coin}${p.lev ? ' ' + kf(p.lev, 0) + 'x' : ''}`, `${kf(p.entry)} → ${kf(p.mark)}${p.liq ? ` · liq ${kf(p.liq)}` : ''}`,
        ks(p.upnl), kcls(p.upnl), p.side));
      const ord = (d.orders || []).map((x) => krow(`${x.coin} limit${x.lev ? ' ' + kf(x.lev, 0) + 'x' : ''}`, x.dist != null ? `fiyata ${x.dist >= 0 ? '+' : '−'}${Math.abs(x.dist).toFixed(1)}%` : '',
        kf(x.px), 'info', x.dir));
      const pap = (d.paper || []).map((p) => krow(p.coin, `${kf(p.entry)} → ${kf(p.mark)}   SL ${kf(p.stop)}`, `${ks(p.upnl)}  (${p.pct >= 0 ? '+' : '−'}${Math.abs(p.pct).toFixed(1)}%)`, kcls(p.upnl), p.side));
      const cl = (d.closed || []).map((t) => krow(t.coin, `${t.src} · ${ktime(t.at)}`, ks(t.pnl), kcls(t.pnl), t.side));
      const al = (d.alerts || []).map((a) => h('div', 'kx-al', h('span', 'kx-at', ktime(a.at)), h('b', null, a.coin), h('span', null, a.t)));
      const right = h('div', 'kx-right',
        ksec('OKX canlı', `${pos.length} pozisyon · ${ord.length} emir`, [...pos, ...ord]),
        ksec('Kağıt pozisyonlar', `${pap.length} açık`, pap),
        ksec('Son kapanışlar', null, cl),
        ksec('KriptoBot uyarıları', null, al));
      const ok = b.phase === 'running' && !b.paused && (b.hb ?? 99) < 180;
      const foot = h('div', 'kx-foot',
        h('span', 'kx-dot' + (ok ? ' on' : '')), h('span', null, `Bot ${ok ? 'çalışıyor' : (b.paused ? 'duraklatıldı' : b.phase || '?')} · OKX modu ${b.okx || '?'}`),
        b.next ? h('span', null, `Sıradaki veri: ${b.next.name} · ${ktime(b.next.at)}`) : null,
        h('span', 'kx-fund', fund ? `Funding   ${fund}` : ''), h('span', 'kx-age', ago(item.at)));
      box.replaceChildren(h('div', 'kx', head, h('div', 'kx-body', coins, right), foot));
    };
    return { update: render };
  },
};

W.inbox = {
  needs: ['notes', 'tick'],
  create(box) {
    const list = h('div', 'inbox');
    const clear = h('button', 'mini-btn', 'Clear');
    clear.addEventListener('click', () => { haptic(); D.notes = []; store.set('notes', []); emit('notes'); });
    box.append(h('div', 'w-title', 'Notifications', clear), list);
    let shown = '';
    return {
      update(kind) {
        const key = D.notes.length + ':' + (D.notes[0]?.at || 0) + ':' + Math.floor(Date.now() / 60000);
        if (key === shown && kind === 'tick') return;
        shown = key;
        list.replaceChildren(...(D.notes.length ? D.notes.map((n) => {
          const e = h('div', 'ib-i', h('div', 'ib-h', h('b', null, n.title || n.text), h('span', null, ago(n.at))), n.title && n.text ? h('div', 'ib-t', n.text) : null);
          e.style.setProperty('--lc', LEVEL_COLOR[n.level] || 'var(--dim)');
          return e;
        }) : [h('div', 'empty', 'Nothing yet.\nSend one with POST /api/notify')]));
      },
    };
  },
};

// ---------------------------------------------------------------- more widgets: helpers
const inflight = {};
/** fetch() + JSON with a localStorage cache; returns stale data when offline. */
function cached(key, url, maxAgeMs) {
  const c = store.get('nc:' + key, null);
  if (c && Date.now() - c.at < maxAgeMs) return Promise.resolve(c.data);
  if (inflight[key]) return inflight[key];
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 10000);
  inflight[key] = fetch(url, { signal: ctl.signal })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((data) => { store.set('nc:' + key, { at: Date.now(), data }); return data; })
    .catch((e) => { if (c) return c.data; throw e; })
    .finally(() => delete inflight[key]);
  return inflight[key];
}

/** Calls load() now and then every intervalMs while the widget is on a visible page. */
function every(intervalMs, load) {
  let last = 0;
  return () => { if (Date.now() - last >= intervalMs) { last = Date.now(); load(); } };
}

function sparkLine(canvas, data, col) {
  if (!canvas.clientWidth || !data || data.length < 2) return;
  const [g, w, hh, dpr] = sizeCanvas(canvas);
  g.clearRect(0, 0, w, hh);
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  g.beginPath();
  data.forEach((v, i) => { const x = (i / (data.length - 1)) * w, y = hh - 2 * dpr - ((v - min) / span) * (hh - 4 * dpr); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.strokeStyle = col; g.lineWidth = 1.5 * dpr; g.lineJoin = 'round'; g.stroke();
}

const fmtNum = (v) => (v == null ? '—' : v >= 1000 ? v.toLocaleString(LOCALE, { maximumFractionDigits: 0 }) : v >= 10 ? v.toFixed(2) : v.toPrecision(4));
const pctSpan = (p) => { const e = h('span', 'chg ' + (p >= 0 ? 'up' : 'down'), `${p >= 0 ? '▲' : '▼'} ${Math.abs(p).toFixed(2)}%`); return e; };
const lines = (v, d) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : d).map((x) => String(x).trim()).filter(Boolean);

/** Gauge-style dial used by several widgets. */
function dialEl() {
  const dial = h('div', 'g-dial'), val = h('div', 'g-val');
  dial.append(val);
  let svg = null;
  dial.set = (pct, text, unit, elapsed) => {
    if (svg) svg.remove();
    dial.insertAdjacentHTML('afterbegin', ringSvg(pct, elapsed)); // numbers only
    svg = dial.firstElementChild;
    val.replaceChildren(String(text), unit ? h('small', null, unit) : '');
  };
  return dial;
}

function canKillAnywhere() {
  return (cfg.pages || []).some((p) => p.enabled !== false && (p.widgets || []).some((w) => w.type === 'processes' && w.options?.allowKill !== false));
}

// ---------------------------------------------------------------- clocks & time
W.analog = {
  bare: true, needs: ['tick'],
  create(box, { o }) {
    const showSec = o.seconds !== false;
    let fmt = null;
    if (o.zone) { try { fmt = new Intl.DateTimeFormat('en-GB', { timeZone: o.zone, hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }); } catch (_) {} }
    const ticks = Array.from({ length: 60 }, (_, i) => {
      const big = i % 5 === 0, a = (i * Math.PI) / 30, r1 = big ? 40 : 43.5;
      return `<line class="tk${big ? ' b' : ''}" x1="${(50 + r1 * Math.sin(a)).toFixed(2)}" y1="${(50 - r1 * Math.cos(a)).toFixed(2)}" x2="${(50 + 46.5 * Math.sin(a)).toFixed(2)}" y2="${(50 - 46.5 * Math.cos(a)).toFixed(2)}"/>`;
    }).join('');
    const nums = o.numbers ? [12, 3, 6, 9].map((n, i) => `<text x="${50 + 33 * Math.sin((i * Math.PI) / 2)}" y="${50 - 33 * Math.cos((i * Math.PI) / 2) + 3.6}">${n}</text>`).join('') : '';
    box.innerHTML = `<svg viewBox="0 0 100 100" class="analog"><circle class="face" cx="50" cy="50" r="48.5"/>${ticks}${nums}` +
      '<line class="hh" x1="50" y1="53" x2="50" y2="27"/><line class="mh" x1="50" y1="55" x2="50" y2="12"/>' +
      (showSec ? '<line class="sh" x1="50" y1="60" x2="50" y2="8"/>' : '') + '<circle class="hub" cx="50" cy="50" r="2.4"/></svg>';
    if (o.label) box.append(h('div', 'an-l', o.label));
    const [hh, mh, sh] = ['.hh', '.mh', '.sh'].map((s) => box.querySelector(s));
    return {
      update() {
        let H, M, S;
        if (fmt) { const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, +x.value])); [H, M, S] = [p.hour, p.minute, p.second]; }
        else { const d = new Date(); [H, M, S] = [d.getHours(), d.getMinutes(), d.getSeconds()]; }
        hh.setAttribute('transform', `rotate(${(H % 12) * 30 + M * 0.5} 50 50)`);
        mh.setAttribute('transform', `rotate(${M * 6 + S * 0.1} 50 50)`);
        sh?.setAttribute('transform', `rotate(${S * 6} 50 50)`);
      },
    };
  },
};

W.progress = {
  needs: ['tick'],
  create(box) {
    const rows = ['Day', 'Week', 'Month', 'Year'].map((n) => {
      const pct = h('span'), bar = h('i');
      const row = h('div', 'pr-row', h('div', 'm-row', h('span', null, n), pct), h('div', 'track', bar));
      return { pct, bar, row };
    });
    box.append(h('div', 'w-title', 'Time'), h('div', 'pr-list', rows.map((r) => r.row)));
    let shown = -1;
    return {
      update() {
        const now = new Date();
        if (now.getMinutes() === shown) return;
        shown = now.getMinutes();
        const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const wk0 = new Date(day0); wk0.setDate(day0.getDate() - ((day0.getDay() + 6) % 7));
        const m0 = new Date(now.getFullYear(), now.getMonth(), 1), m1 = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const y0 = new Date(now.getFullYear(), 0, 1), y1 = new Date(now.getFullYear() + 1, 0, 1);
        const vals = [(now - day0) / 864e5, (now - wk0) / (7 * 864e5), (now - m0) / (m1 - m0), (now - y0) / (y1 - y0)];
        vals.forEach((v, i) => { rows[i].pct.textContent = (v * 100).toFixed(i === 3 ? 1 : 0) + '%'; rows[i].bar.style.width = v * 100 + '%'; });
      },
    };
  },
};

W.stopwatch = {
  needs: ['fast'],
  create(box, { page, w }) {
    const key = `sw:${page.id}/${w.id}`;
    let st = store.get(key, null) || { start: null, acc: 0, laps: [] };
    const save = () => store.set(key, st);
    const t = h('div', 'sw-t'), laps = h('div', 'sw-laps');
    const a = h('button', 'pb main', '▶'), b = h('button', 'pb', '↺');
    box.append(h('div', 'w-title', 'Stopwatch'), t, h('div', 'pomo-btns', b, a), laps);
    const elapsed = () => st.acc + (st.start ? Date.now() - st.start : 0);
    const fmtSw = (ms) => { const s = Math.floor(ms / 1000); const hh = Math.floor(s / 3600); return (hh ? hh + ':' + pad(Math.floor((s % 3600) / 60)) : Math.floor(s / 60)) + ':' + pad(s % 60) + '.' + Math.floor((ms % 1000) / 100); };
    const renderLaps = () => laps.replaceChildren(...st.laps.slice(-6).reverse().map((l, i, arr) => h('div', 'sw-lap', h('span', null, '#' + (st.laps.length - i)), h('span', null, fmtSw(l)))));
    const paint = () => { a.textContent = st.start ? '⏸' : '▶'; b.textContent = st.start ? '⚑' : '↺'; box.classList.toggle('run', !!st.start); };
    a.addEventListener('click', () => { haptic(); if (st.start) { st.acc = elapsed(); st.start = null; } else st.start = Date.now(); save(); paint(); });
    b.addEventListener('click', () => { haptic(); if (st.start) st.laps.push(elapsed()); else st = { start: null, acc: 0, laps: [] }; save(); paint(); renderLaps(); });
    paint(); renderLaps();
    return { update() { t.textContent = fmtSw(elapsed()); } };
  },
};

W.timer = {
  needs: ['tick'],
  create(box, { o, page, w }) {
    const key = `tm:${page.id}/${w.id}`;
    const presets = lines(o.presets, ['1', '3', '5', '10', '15', '25']).map(Number).filter((n) => n > 0).slice(0, 8);
    let st = store.get(key, null) || { endsAt: null, left: 0, total: 0 };
    const save = () => store.set(key, st);
    const dial = dialEl(), btns = h('div', 'tm-btns');
    box.append(h('div', 'w-title', o.label || 'Timer'), dial, btns);
    box.style.setProperty('--q', o.color || '#38bdf8');
    const remaining = () => (st.endsAt ? Math.max(0, st.endsAt - Date.now()) : st.left);
    const renderBtns = () => {
      if (!st.total) {
        btns.replaceChildren(...presets.map((m) => { const b = h('button', 'chip-btn', m + 'm'); b.addEventListener('click', () => { haptic(); st = { endsAt: Date.now() + m * 60000, left: m * 60000, total: m * 60000 }; save(); renderBtns(); render(); }); return b; }));
      } else {
        const p = h('button', 'pb main', st.endsAt ? '⏸' : '▶'), x = h('button', 'pb', '✕');
        p.addEventListener('click', () => { haptic(); if (st.endsAt) { st.left = remaining(); st.endsAt = null; } else st.endsAt = Date.now() + st.left; save(); renderBtns(); });
        x.addEventListener('click', () => { haptic(); st = { endsAt: null, left: 0, total: 0 }; save(); renderBtns(); render(); });
        btns.replaceChildren(x, p);
      }
    };
    const render = () => {
      if (st.endsAt && remaining() <= 0) {
        st = { endsAt: null, left: 0, total: 0 }; save(); renderBtns();
        buzz('0,300,150,300,150,600');
        toast('Time is up', 'ok', '⏳ ' + (o.label || 'Timer'), 6);
      }
      const left = remaining();
      dial.set(st.total ? 100 * (left / st.total) : 0, st.total ? fmtTime(left + 999) : '—');
      box.classList.toggle('run', !!st.endsAt);
    };
    renderBtns();
    return { update: render };
  },
};

W.counter = {
  needs: [],
  create(box, { o, page, w }) {
    const key = `ct:${page.id}/${w.id}`;
    const today = new Date().toDateString();
    let st = store.get(key, null) || { n: 0, day: today };
    if (o.daily && st.day !== today) st = { n: 0, day: today };
    const step = Number(o.step) || 1;
    const num = h('div', 'ct-n'), minus = h('button', 'pb', '−'), plus = h('button', 'pb main', '+'), reset = h('button', 'mini-btn', 'Reset');
    box.style.setProperty('--q', o.color || '#a78bfa');
    box.append(h('div', 'w-title', o.label || 'Counter', reset), num, h('div', 'pomo-btns', minus, plus));
    const set = (n) => { st.n = n; st.day = new Date().toDateString(); store.set(key, st); num.textContent = st.n; };
    plus.addEventListener('click', () => { haptic(); set(st.n + step); });
    minus.addEventListener('click', () => { haptic(); set(st.n - step); });
    reset.addEventListener('click', () => { haptic(); set(0); });
    num.textContent = st.n;
    return {};
  },
};

W.breathe = {
  needs: ['tick'],
  create(box, { o }) {
    const PATTERNS = { box: [['Inhale', 4], ['Hold', 4], ['Exhale', 4], ['Hold', 4]], relax: [['Inhale', 4], ['Hold', 7], ['Exhale', 8]], calm: [['Inhale', 5], ['Exhale', 5]] };
    const phases = PATTERNS[o.pattern] || PATTERNS.box;
    const cycle = phases.reduce((a, p) => a + p[1], 0);
    const ball = h('div', 'br-ball'), word = h('div', 'br-w', 'Tap to start'), count = h('div', 'br-c');
    box.append(h('div', 'br-stage', ball, h('div', 'br-txt', word, count)));
    let start = null, lastPhase = -1;
    box.addEventListener('click', () => { haptic(); start = start ? null : Date.now(); lastPhase = -1; if (!start) { ball.style.transition = 'transform 1s ease'; ball.style.transform = 'scale(.45)'; word.textContent = 'Tap to start'; count.textContent = ''; } });
    ball.style.transform = 'scale(.45)';
    return {
      update() {
        if (!start) return;
        let t = ((Date.now() - start) / 1000) % cycle, i = 0;
        while (t >= phases[i][1]) { t -= phases[i][1]; i++; }
        const [name, secs] = phases[i];
        if (i !== lastPhase) {
          lastPhase = i;
          ball.style.transition = `transform ${secs}s ease-in-out`;
          if (name === 'Inhale') ball.style.transform = 'scale(1)';
          if (name === 'Exhale') ball.style.transform = 'scale(.45)';
          word.textContent = name;
        }
        count.textContent = Math.ceil(secs - t);
      },
    };
  },
};

const QUOTES = [
  ['The best way out is always through.', 'Robert Frost'],
  ['Simplicity is the ultimate sophistication.', 'Leonardo da Vinci'],
  ['Well begun is half done.', 'Aristotle'],
  ['Premature optimization is the root of all evil.', 'Donald Knuth'],
  ['Talk is cheap. Show me the code.', 'Linus Torvalds'],
  ['First, solve the problem. Then, write the code.', 'John Johnson'],
  ['Programs must be written for people to read.', 'Harold Abelson'],
  ['Make it work, make it right, make it fast.', 'Kent Beck'],
  ['Deleted code is debugged code.', 'Jeff Sickel'],
  ['Waste no more time arguing what a good man should be. Be one.', 'Marcus Aurelius'],
  ['What stands in the way becomes the way.', 'Marcus Aurelius'],
  ['We suffer more often in imagination than in reality.', 'Seneca'],
  ['Luck is what happens when preparation meets opportunity.', 'Seneca'],
  ['Do what you can, with what you have, where you are.', 'Theodore Roosevelt'],
  ['Nothing in life is to be feared, it is only to be understood.', 'Marie Curie'],
  ['Imagination is more important than knowledge.', 'Albert Einstein'],
  ['Knowledge is power.', 'Francis Bacon'],
  ['Measure twice, cut once.', 'Proverb'],
  ['Rome wasn’t built in a day.', 'Proverb'],
  ['Drop by drop, a lake is formed.', 'Turkish proverb'],
  ['Patience is bitter, but its fruit is sweet.', 'Proverb'],
  ['A journey of a thousand miles begins with a single step.', 'Laozi'],
];

W.quote = {
  needs: ['tick'],
  create(box, { o }) {
    const custom = lines(o.quotes, []).map((l) => { const i = l.lastIndexOf(' — '); return i > 0 ? [l.slice(0, i), l.slice(i + 3)] : [l, '']; });
    const list = custom.length ? custom : QUOTES;
    const mins = Math.max(1, Number(o.minutes) || 30);
    const q = h('div', 'qt-q'), a = h('div', 'qt-a');
    box.append(h('div', 'qt-mark', '“'), q, a);
    let offset = 0, shown = -1;
    const pick = () => {
      const idx = (Math.floor(Date.now() / (mins * 60000)) + offset) % list.length;
      if (idx === shown) return;
      shown = idx;
      q.textContent = list[idx][0];
      a.textContent = list[idx][1] ? '— ' + list[idx][1] : '';
      box.style.setProperty('--qf', list[idx][0].length < 40 ? 1.25 : list[idx][0].length < 80 ? 1 : 0.8);
    };
    box.addEventListener('click', () => { haptic(); offset++; pick(); });
    return { update: pick };
  },
};

W.checklist = {
  needs: ['tick'],
  create(box, { o, page, w }) {
    const items = lines(o.items, ['Water the plants', 'Stretch', 'Inbox zero']);
    const key = `cl:${page.id}/${w.id}`;
    const day = () => new Date().toDateString();
    let st = store.get(key, null) || { day: day(), done: [] };
    const fresh = () => { if (o.daily !== false && st.day !== day()) st = { day: day(), done: [] }; };
    const head = h('span', 'w-sub');
    const list = h('div', 'cl-list');
    box.append(h('div', 'w-title', o.title || 'Today', head), list);
    const render = () => {
      fresh();
      const n = items.filter((x) => st.done.includes(x)).length;
      head.textContent = `${n} / ${items.length}`;
      box.classList.toggle('all', n === items.length && n > 0);
      list.replaceChildren(...items.map((it) => {
        const done = st.done.includes(it);
        const row = h('button', 'cl-i' + (done ? ' done' : ''), h('span', 'cl-box', done ? '✓' : ''), h('span', 'cl-t', it));
        row.addEventListener('click', () => {
          haptic();
          st.done = done ? st.done.filter((x) => x !== it) : [...st.done, it];
          st.day = day();
          store.set(key, st);
          render();
        });
        return row;
      }));
    };
    let lastDay = day();
    render();
    return { update() { if (day() !== lastDay) { lastDay = day(); render(); } } };
  },
};

// ---------------------------------------------------------------- phone & PC
W.battery = {
  needs: ['tick'],
  create(box) {
    const dial = dialEl(), sub = h('div', 'g-sub');
    box.append(dial, h('div', 'g-label', 'PHONE'), sub);
    const load = every(20_000, () => {
      if (!bridge) { dial.set(0, '—'); sub.textContent = 'Only on the phone'; return; }
      try {
        const b = JSON.parse(bridge.battery());
        box.style.setProperty('--q', b.plugged ? '#22c55e' : b.level <= 20 ? '#ef4444' : b.level <= 40 ? '#f59e0b' : '#84cc16');
        dial.set(b.level, b.level, '%');
        sub.textContent = (b.plugged ? '⚡ Charging' : 'On battery') + (b.temp ? ` · ${b.temp.toFixed(0)}°C` : '');
      } catch (_) {}
    });
    return { update: load };
  },
};

W.topprocs = {
  needs: ['procs'],
  create(box, { o }) {
    const byMem = o.sort === 'mem';
    const list = h('div', 'tp-list');
    box.style.setProperty('--c', '#f472b6');
    box.append(h('div', 'w-title', byMem ? 'Top memory' : 'Top CPU'), list);
    return {
      update() {
        const data = D.procs;
        if (!data?.groups?.length) { list.replaceChildren(h('div', 'empty', 'Measuring…')); return; }
        const n = Math.max(1, Math.floor((box.clientHeight - 30) / 24));
        const top = [...data.groups].sort((a, b) => (byMem ? b.memMb - a.memMb : b.cpu - a.cpu)).slice(0, n);
        list.replaceChildren(...top.map((g) => {
          const ico = h('div', 'p-ico');
          fillIcon(ico, g);
          const row = h('div', 'tp-i', ico, h('span', 'tp-n', g.title + (g.count > 1 ? ` ×${g.count}` : '')), h('b', null, byMem ? fmtMem(g.memMb) : g.cpu.toFixed(1) + '%'));
          row.addEventListener('click', () => { haptic(); openSheet(g, canKillAnywhere()); });
          return row;
        }));
      },
    };
  },
};

W.quotaring = {
  needs: ['quotas', 'tick'],
  create(box, { o }) {
    const prov = o.provider || 'claude', idx = Number(o.limit) || 0;
    const st = Q_STYLE[prov] || { color: '#94a3b8', logo: '●' };
    box.style.setProperty('--q', st.color);
    const dial = dialEl(), label = h('div', 'g-label'), sub = h('div', 'g-sub');
    box.append(dial, label, sub);
    let last = 0;
    const render = () => {
      const p = quotaProviders().find((x) => x.id === prov);
      const l = p?.limits?.[idx];
      if (!l) { dial.set(0, '—'); label.textContent = `${st.logo} ${p?.name || prov}`; sub.textContent = D.quotas ? 'No data' : 'Waiting…'; return; }
      const pace = paceInfo(l);
      dial.style.setProperty('--qc', l.percent >= 95 ? '#ef4444' : l.percent >= 80 ? '#f59e0b' : 'var(--q)');
      dial.set(l.percent, Math.round(l.percent), '%', pace?.elapsed);
      label.textContent = `${st.logo} ${p.name} · ${l.label}`;
      sub.textContent = l.resetsAt ? 'resets in ' + fmtDur(l.resetsAt - Date.now()) : '';
      sub.className = 'g-sub ' + (pace?.cls === 'over' ? 'hot' : '');
    };
    return { update(kind) { if (kind === 'tick' && Date.now() - last < 30_000) return; last = Date.now(); render(); } };
  },
};

W.volume = {
  needs: ['state'],
  create(box) {
    const fill = h('i'), bar = h('div', 'vb', fill), pct = h('div', 'vb-v', '--');
    const mute = h('button', 'pb', '🔇'), down = h('button', 'pb', '−'), up = h('button', 'pb', '+');
    box.append(h('div', 'w-title', 'Volume'), h('div', 'vb-row', bar, pct), h('div', 'pomo-btns', mute, down, up));
    let dragging = false, timer = 0, level = 0;
    const vertical = () => box.clientHeight > box.clientWidth * 1.15;
    const paint = (v, muted) => {
      level = v;
      box.classList.toggle('vert', vertical());
      fill.style[vertical() ? 'height' : 'width'] = v + '%';
      fill.style[vertical() ? 'width' : 'height'] = '100%';
      pct.textContent = muted ? 'muted' : v + '%';
      box.classList.toggle('muted', !!muted);
    };
    const fromPointer = (e) => {
      const r = bar.getBoundingClientRect();
      const f = vertical() ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
      const v = Math.round(Math.max(0, Math.min(1, f)) * 100);
      paint(v, false);
      clearTimeout(timer);
      timer = setTimeout(() => api('/volume?level=' + v, 'POST').catch(() => {}), 80);
    };
    bar.addEventListener('pointerdown', (e) => { dragging = true; bar.setPointerCapture(e.pointerId); fromPointer(e); });
    bar.addEventListener('pointermove', (e) => { if (dragging) fromPointer(e); });
    bar.addEventListener('pointerup', () => setTimeout(() => (dragging = false), 400));
    const op = (q) => async () => { haptic(); try { const a = await api('/volume?' + q, 'POST'); paint(a.volume, a.muted); } catch (_) {} };
    mute.addEventListener('click', op('op=mute'));
    down.addEventListener('click', op('op=down'));
    up.addEventListener('click', op('op=up'));
    return { update() { const a = D.state?.audio; if (a && !dragging) paint(a.volume, a.muted); } };
  },
};

// ---------------------------------------------------------------- sky & air
function moonPhase(date) {
  const syn = 29.530588853;
  const age = ((((date - Date.UTC(2000, 0, 6, 18, 14)) / 864e5) % syn) + syn) % syn;
  const names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  const i = Math.floor(((age + syn / 16) % syn) / (syn / 8));
  return { name: names[i], icon: '🌑🌒🌓🌔🌕🌖🌗🌘'.match(/./gu)[i], illum: (1 - Math.cos((2 * Math.PI * age) / syn)) / 2 };
}

W.sun = {
  needs: ['weather', 'tick'],
  create(box) {
    box.innerHTML = '<div class="w-title">Sun &amp; moon<span class="w-sub"></span></div>' +
      '<svg class="sun-arc" viewBox="0 0 200 80" preserveAspectRatio="xMidYMax meet"><path class="sa-bg" d="M10 75 A90 70 0 0 1 190 75"/><path class="sa-fg" d="M10 75 A90 70 0 0 1 190 75"/><line class="sa-h" x1="2" y1="75" x2="198" y2="75"/><circle class="sa-sun" r="7" cx="10" cy="75"/></svg>' +
      '<div class="sun-row"><span class="sr"></span><span class="sl"></span><span class="ss"></span></div><div class="moon"></div>';
    const q = (s) => box.querySelector(s);
    const fg = q('.sa-fg'), sun = q('.sa-sun');
    const len = fg.getTotalLength();
    fg.style.strokeDasharray = len;
    let shown = '';
    return {
      update() {
        const d = D.weather?.daily;
        if (!d?.sunrise) { q('.sl').textContent = D.weather === null ? 'Loading…' : 'Weather unavailable'; return; }
        const now = new Date();
        const key = now.getHours() + ':' + now.getMinutes();
        if (key === shown) return;
        shown = key;
        const rise = new Date(d.sunrise[0]), set = new Date(d.sunset[0]);
        const f = Math.max(0, Math.min(1, (now - rise) / (set - rise)));
        fg.style.strokeDashoffset = len * (1 - f);
        const pt = fg.getPointAtLength(len * f);
        sun.setAttribute('cx', pt.x.toFixed(1)); sun.setAttribute('cy', pt.y.toFixed(1));
        box.classList.toggle('night', now < rise || now > set);
        const hm = (t) => t.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
        q('.sr').textContent = '↑ ' + hm(rise);
        q('.ss').textContent = hm(set) + ' ↓';
        q('.sl').textContent = now < rise ? `rises in ${fmtDur(rise - now)}` : now > set ? 'after sunset' : `${fmtDur(set - now)} of light left`;
        q('.w-sub').textContent = 'Day ' + fmtDur((d.daylight_duration?.[0] ?? (set - rise) / 1000) * 1000) + (d.uv_index_max?.[0] != null ? ` · UV ${Math.round(d.uv_index_max[0])}` : '');
        const m = moonPhase(now);
        q('.moon').textContent = `${m.icon} ${m.name} · ${Math.round(m.illum * 100)}%`;
      },
    };
  },
};

const AQI_BANDS = [[20, 'Good', '#22c55e'], [40, 'Fair', '#84cc16'], [60, 'Moderate', '#eab308'], [80, 'Poor', '#f97316'], [100, 'Very poor', '#ef4444'], [1e9, 'Extremely poor', '#a855f7']];
W.air = {
  needs: ['tick'],
  create(box) {
    const v = h('div', 'aq-v', '—'), cat = h('div', 'aq-c', 'Loading…'), chips = h('div', 'aq-chips');
    box.append(h('div', 'w-title', 'Air quality', h('span', 'w-sub', cfg.weather?.city || '')), h('div', 'aq-main', v, cat), chips);
    const load = every(30 * 60_000, async () => {
      const { lat, lon } = cfg.weather || DEFAULT_CFG.weather;
      try {
        const d = await cached(`air:${lat},${lon}`, `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
          '&current=european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide&timezone=auto', 30 * 60_000);
        const c = d.current || {};
        const band = AQI_BANDS.find((b) => (c.european_aqi ?? 0) <= b[0]);
        box.style.setProperty('--c', band[2]);
        v.textContent = Math.round(c.european_aqi ?? 0);
        cat.textContent = band[1] + ' · European AQI';
        chips.replaceChildren(...[['PM2.5', c.pm2_5], ['PM10', c.pm10], ['O₃', c.ozone], ['NO₂', c.nitrogen_dioxide]]
          .filter((x) => x[1] != null).map(([n, x]) => h('span', 'chip', `${n} ${Math.round(x)}`)));
      } catch (_) { cat.textContent = 'Unavailable'; }
    });
    return { update: load };
  },
};

// ---------------------------------------------------------------- the internet
W.hackernews = {
  needs: ['tick'],
  create(box) {
    const list = h('div', 'hn-list', h('div', 'empty', 'Loading…'));
    box.style.setProperty('--c', '#ff6600');
    box.append(h('div', 'w-title', 'Hacker News', h('span', 'w-sub', '')), list);
    const load = every(15 * 60_000, async () => {
      try {
        const key = 'hn';
        let data = store.get('nc:' + key, null);
        if (!data || Date.now() - data.at > 15 * 60_000) {
          const ids = (await cached('hn-ids', 'https://hacker-news.firebaseio.com/v0/topstories.json', 15 * 60_000)).slice(0, 15);
          const items = await Promise.all(ids.map((id) => fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then((r) => r.json()).catch(() => null)));
          data = { at: Date.now(), data: items.filter(Boolean).map((i) => ({ t: i.title, u: i.url, s: i.score, c: i.descendants || 0 })) };
          store.set('nc:' + key, data);
        }
        box.querySelector('.w-sub').textContent = ago(data.at);
        const n = Math.max(1, Math.floor((box.clientHeight - 30) / 33));
        list.replaceChildren(...data.data.slice(0, n).map((s, i) => {
          let host = '';
          try { host = s.u ? new URL(s.u).hostname.replace(/^www\./, '') : 'news.ycombinator.com'; } catch (_) {}
          return h('div', 'hn-i', h('span', 'hn-r', i + 1), h('div', 'hn-b', h('div', 'hn-t', s.t), h('div', 'hn-m', `▲ ${s.s} · ${s.c} comments · ${host}`)));
        }));
      } catch (_) { if (!list.querySelector('.hn-i')) list.replaceChildren(h('div', 'empty', 'Offline')); }
    });
    return { update: load };
  },
};

W.exchange = {
  needs: ['tick'],
  create(box, { o }) {
    const base = (o.base || 'EUR').toUpperCase();
    const syms = lines(o.symbols, ['TRY', 'USD', 'GBP']).map((s) => s.toUpperCase()).slice(0, 8);
    const list = h('div', 'fx-list', h('div', 'empty', 'Loading…'));
    box.append(h('div', 'w-title', `1 ${base}`, h('span', 'w-sub', '')), list);
    const load = every(60 * 60_000, async () => {
      try {
        const from = new Date(Date.now() - 31 * 864e5).toISOString().slice(0, 10);
        const d = await cached(`fx:${base}:${syms}`, `https://api.frankfurter.dev/v1/${from}..?base=${base}&symbols=${syms.join(',')}`, 60 * 60_000);
        const days = Object.keys(d.rates).sort();
        box.querySelector('.w-sub').textContent = 'ECB · ' + days.at(-1);
        list.replaceChildren(...syms.map((s) => {
          const series = days.map((k) => d.rates[k][s]).filter((x) => x != null);
          const last = series.at(-1), prev = series.at(-2) ?? last;
          const c = h('canvas', 'fx-sp');
          const row = h('div', 'fx-i', h('b', null, s), h('span', 'fx-v', fmtNum(last)), pctSpan(((last - prev) / prev) * 100), c);
          requestAnimationFrame(() => sparkLine(c, series, last >= series[0] ? '#22c55e' : '#ef4444'));
          return row;
        }));
      } catch (_) { list.replaceChildren(h('div', 'empty', 'Rates unavailable')); }
    });
    return { update: load };
  },
};

W.crypto = {
  needs: ['tick'],
  create(box, { o }) {
    const coins = lines(o.coins, ['bitcoin', 'ethereum', 'solana']).map((s) => s.toLowerCase()).slice(0, 8);
    const cur = (o.currency || 'usd').toLowerCase();
    const list = h('div', 'fx-list', h('div', 'empty', 'Loading…'));
    box.append(h('div', 'w-title', 'Crypto', h('span', 'w-sub', cur.toUpperCase() + ' · 24 h · 7 d')), list);
    const load = every(5 * 60_000, async () => {
      try {
        const d = await cached(`cg:${cur}:${coins}`, `https://api.coingecko.com/api/v3/coins/markets?vs_currency=${cur}&ids=${coins.join(',')}&sparkline=true&price_change_percentage=24h`, 5 * 60_000);
        list.replaceChildren(...d.map((c) => {
          const cv = h('canvas', 'fx-sp');
          const series = c.sparkline_in_7d?.price || [];
          requestAnimationFrame(() => sparkLine(cv, series, (c.price_change_percentage_24h ?? 0) >= 0 ? '#22c55e' : '#ef4444'));
          return h('div', 'fx-i', h('b', null, (c.symbol || '').toUpperCase()), h('span', 'fx-v', fmtNum(c.current_price)), pctSpan(c.price_change_percentage_24h ?? 0), cv);
        }));
      } catch (_) { list.replaceChildren(h('div', 'empty', 'Prices unavailable')); }
    });
    return { update: load };
  },
};

W.image = {
  needs: ['tick'],
  create(box, { o }) {
    const url = String(o.url || '');
    const img = h('img', 'im-img');
    img.alt = '';
    img.style.objectFit = o.fit === 'contain' ? 'contain' : 'cover';
    box.append(img);
    if (o.caption) box.append(h('div', 'im-cap', o.caption));
    if (!/^https?:\/\//i.test(url)) { box.replaceChildren(h('div', 'empty', 'Set an image address (https://…) in the settings')); return {}; }
    img.onerror = () => box.classList.add('err');
    img.onload = () => box.classList.remove('err');
    const mins = Number(o.minutes) || 0;
    const load = every(mins > 0 ? mins * 60_000 : 1e12, () => { img.src = mins > 0 ? url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now() : url; });
    return { update: load };
  },
};

const WIDGET_ICONS = { clock: '🕒', weather: '⛅', forecast: '🌦️', media: '🎵', stat: '📈', gauge: '⏲️', chart: '📊', meters: '💾', quotas: '✳️', sessions: '🤖',
  github: '🐙', processes: '⚙️', shortcuts: '🎛️', button: '🔘', worldclock: '🌍', calendar: '📅', pomodoro: '🍅', countdown: '⏳', note: '📝', command: '💻',
  push: '📡', inbox: '📬', label: '🔤', analog: '🕰️', progress: '📆', stopwatch: '⏱️', timer: '⏲️', counter: '🔢', breathe: '🫁', quote: '💬',
  checklist: '✅', battery: '🔋', topprocs: '🔥', quotaring: '🎯', volume: '🔊', sun: '🌅', air: '🍃', hackernews: '📰', exchange: '💱', crypto: '🪙', image: '🖼️' };

// ================================================================= pages
const pager = $('pager');
let pages = [];       // enabled pages
let mounted = [];     // { pi, def, inst, ctx, dirty }
let layoutKey = '';
let curPage = 0;

function buildLayout() {
  const enabled = (cfg.pages || []).filter((p) => p.enabled !== false && Array.isArray(p.widgets));
  const next = enabled.length ? enabled : FALLBACK_PAGES;
  const key = JSON.stringify([next, cfg.shortcuts, cfg.display?.showSeconds]);
  if (key === layoutKey) return;
  layoutKey = key;
  const prevId = pages[curPage]?.id;
  pages = next;
  for (const m of mounted) { try { m.inst.destroy?.(); } catch (_) {} }
  mounted = [];
  closeSheet();
  pager.replaceChildren();
  pages.forEach((p, pi) => {
    const grid = h('div', 'grid');
    for (const w of p.widgets) {
      const def = W[w.type];
      if (!def) continue;
      const box = h('div', `w w-${w.type}${def.bare ? ' bare' : ' card'}`);
      box.style.gridArea = `${w.y + 1} / ${w.x + 1} / span ${w.h} / span ${w.w}`;
      grid.appendChild(box);
      const ctx = { page: p, w, o: w.options || {}, box };
      let inst;
      try { inst = def.create(box, ctx) || {}; } catch (e) { box.replaceChildren(h('div', 'empty', `${w.type}: ${e.message}`)); inst = {}; }
      mounted.push({ pi, def, inst, ctx, dirty: true });
    }
    const sec = h('section', 'page', grid);
    sec.dataset.id = p.id;
    pager.appendChild(sec);
  });
  buildDots();
  const idx = Math.max(0, pages.findIndex((p) => p.id === prevId));
  curPage = -1;
  goPage(idx, true);
  requestAnimationFrame(() => setActive(true));
}

function activeSet() { return new Set([curPage - 1, curPage, curPage + 1]); }
const pageOf = (kind) => mounted.filter((m) => m.pi === curPage && m.def.needs.includes(kind)).length > 0;
const anyNeeds = (kind) => mounted.some((m) => m.def.needs.includes(kind));

function runUpdate(m, kind) {
  try { m.inst.update?.(kind); } catch (e) { console.warn(m.ctx.w.type, e); }
}

/** Delivers fresh data to the widgets on the visible pages; the others catch up when they come into view. */
function emit(kind) {
  const act = activeSet();
  for (const m of mounted) {
    if (!m.def.needs.includes(kind)) continue;
    if (act.has(m.pi)) runUpdate(m, kind); else m.dirty = true;
  }
}

function setActive(all = false) {
  const act = activeSet();
  for (const m of mounted) {
    if ((m.dirty || all) && act.has(m.pi)) {
      m.dirty = false;
      for (const k of m.def.needs) runUpdate(m, k);
    }
  }
}

// ---------------------------------------------------------------- navigation: swipe, dots, overview, volume keys, agent events
function buildDots() {
  $('dots').replaceChildren(...pages.map(() => h('i')));
  $('dots').hidden = pages.length < 2;
}

function updateDots() {
  [...$('dots').children].forEach((d, i) => d.classList.toggle('on', i === curPage));
}

let snapTimer = 0;
function goPage(i, instant = false) {
  i = Math.max(0, Math.min(pages.length - 1, i));
  if (!instant) { pager.scrollTo({ left: i * window.innerWidth, behavior: 'smooth' }); return; }
  // scroll-snap-stop: always would stop a programmatic jump at the next page, so snapping is paused for the jump.
  pager.style.scrollSnapType = 'none';
  pager.scrollLeft = i * window.innerWidth;
  onScroll();
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => (pager.style.scrollSnapType = ''), 120);
}

function gotoPageRef(ref) {
  const n = typeof ref === 'number' ? ref - 1 : /^\d+$/.test(String(ref)) ? +ref - 1 : pages.findIndex((p) => p.id === ref || p.title.toLowerCase() === String(ref).toLowerCase());
  if (n < 0 || n >= pages.length) return -1;
  lastTouch = Date.now();
  goPage(n, Math.abs(n - curPage) > 1);
  return n;
}

// An automation rule that switches pages "while active" holds its page (no idle return); when the rule ends the panel
// goes back to the page it was on, unless you moved on yourself in the meantime.
let ruleHold = null; // { rule, page, from, at }
function ruleGoto(d) {
  const from = ruleHold ? ruleHold.from : curPage;
  const n = gotoPageRef(d.page);
  if (n >= 0 && d.hold && d.rule) ruleHold = { rule: d.rule, page: n, from, at: Date.now() };
}
function endHold() {
  const h = ruleHold;
  ruleHold = null;
  if (h && curPage === h.page && h.from !== h.page) { lastTouch = Date.now(); goPage(h.from, Math.abs(h.from - curPage) > 1); }
}

let titleTimer = 0;
function flashTitle() {
  const p = pages[curPage];
  if (!p || pages.length < 2) return;
  const t = $('ptitle');
  t.textContent = `${p.icon || ''} ${p.title}`.trim();
  t.classList.add('on');
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => t.classList.remove('on'), 900);
}

function onScroll() {
  const p = Math.round(pager.scrollLeft / window.innerWidth);
  if (p === curPage) return;
  curPage = p;
  updateDots();
  flashTitle();
  setActive();
  if (sheet) closeSheet();
  if (pageOf('procs')) loadProcs();
}
pager.addEventListener('scroll', onScroll, { passive: true });

function openOverview() {
  haptic();
  const ov = $('overview');
  const tile = (p, i) => {
    const map = h('div', 'ov-map', p.widgets.map((w) => {
      const b = h('span', null, WIDGET_ICONS[w.type] || '▫️');
      b.style.gridArea = `${w.y + 1} / ${w.x + 1} / span ${w.h} / span ${w.w}`;
      return b;
    }));
    const t = h('button', 'ov-tile' + (i === curPage ? ' on' : ''), map, h('div', 'ov-name', h('b', null, `${i + 1}`), ` ${p.icon || ''} ${p.title}`));
    t.addEventListener('click', (e) => { e.stopPropagation(); haptic(); closeOverview(); goPage(i, true); });
    return t;
  };
  $('ovGrid').replaceChildren(...pages.map(tile));
  $('ovGrid').style.setProperty('--n', Math.min(4, Math.ceil(Math.sqrt(pages.length * 1.6))));
  ov.hidden = false;
}
function closeOverview() { $('overview').hidden = true; }
$('overview').addEventListener('click', closeOverview);
$('dots').addEventListener('click', openOverview);

// Long press on an empty part of a page opens the overview too.
let pressTimer = 0, pressAt = null;
pager.addEventListener('pointerdown', (e) => {
  if (!e.target.classList.contains('grid') && !e.target.classList.contains('page')) return;
  pressAt = [e.clientX, e.clientY];
  pressTimer = setTimeout(() => { pressAt = null; openOverview(); }, 550);
});
pager.addEventListener('pointermove', (e) => { if (pressAt && Math.hypot(e.clientX - pressAt[0], e.clientY - pressAt[1]) > 12) { clearTimeout(pressTimer); pressAt = null; } });
['pointerup', 'pointercancel'].forEach((ev) => pager.addEventListener(ev, () => { clearTimeout(pressTimer); pressAt = null; }));

/** Called by the Android shell (volume keys) and by arrow keys in a desktop browser. */
window.onAndroidKey = (k) => {
  lastTouch = Date.now();
  if (nightOn) { wakeUntil = Date.now() + 30_000; setNight(false); return; }
  if (!$('overview').hidden) closeOverview();
  if (k === 'next') goPage(curPage + 1 >= pages.length ? 0 : curPage + 1, true);
  else if (k === 'prev') goPage(curPage - 1 < 0 ? pages.length - 1 : curPage - 1, true);
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') window.onAndroidKey('next');
  else if (e.key === 'ArrowLeft') window.onAndroidKey('prev');
  else if (e.key === 'Escape' || e.key === 'o') ($('overview').hidden ? openOverview() : closeOverview());
});
window.onAndroidBack = () => {
  if (!$('approval').hidden) return; // answer it (or let it time out); Back must not dismiss a permission prompt
  if (!$('overview').hidden) closeOverview();
  else if (sheet) closeSheet();
  else if (curPage !== 0) goPage(0, true);
  else openOverview();
};
window.addEventListener('resize', () => goPage(curPage, true));

['pointerdown', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => {
  lastTouch = Date.now();
  if (nightOn) { wakeUntil = Date.now() + 30_000; setNight(false); }
}, { passive: true, capture: true }));

// ---------------------------------------------------------------- clock tick & night mode
function parseHM(s) { const [hh, mm] = (s || '0:0').split(':').map(Number); return hh * 60 + (mm || 0); }
function isNight(now) {
  const n = cfg.night || {};
  if (!n.enabled) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  const a = parseHM(n.start), b = parseHM(n.end);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

function setNight(on) {
  if (on === nightOn) return;
  nightOn = on;
  document.body.classList.toggle('night', on);
  applyBrightness(true);
}

// ---------------------------------------------------------------- phone sensors
// Room light (lux) and proximity come from the Android shell. Brightness can follow the room, the night screen can
// come on when the room goes dark, and a hand near the phone wakes the night screen.
let lux = null, darkSince = 0, darkRoom = false, lastBrightness = null;

/** 1 lux → 5 %, 10 → 37 %, 100 → 68 %, 1000+ lux → 100 % (perceived brightness is roughly logarithmic). */
const luxToBrightness = (l) => Math.max(0.05, Math.min(1, 0.05 + (0.95 * Math.log10(l + 1)) / 3));

function applyBrightness(force = false) {
  if (!bridge) return;
  let v = -1; // the phone's own setting
  if (nightOn) v = cfg.night?.brightness ?? 0.02;
  else if (cfg.display?.autoBrightness && lux != null) v = luxToBrightness(lux);
  if (!force && lastBrightness != null && v >= 0 && lastBrightness >= 0 && Math.abs(v - lastBrightness) < 0.04) return;
  lastBrightness = v;
  try { bridge.setBrightness(v); } catch (_) {}
}

window.onAndroidSensor = (kind, value) => {
  if (kind === 'light') {
    lux = +value;
    // dark room: below 3 lux for 30 s; light again above 15 lux
    if (lux < 3) { darkSince ||= Date.now(); } else darkSince = 0;
    if (darkRoom && lux > 15) darkRoom = false;
    applyBrightness();
  } else if (kind === 'proximity' && value === true && cfg.display?.proximityWake !== false && nightOn) {
    wakeUntil = Date.now() + 30_000;
    setNight(false);
  }
};

function tick() {
  const now = new Date();
  $('nClock').textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());
  $('nDate').textContent = now.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
  if (darkSince && Date.now() - darkSince > 30_000) darkRoom = true;
  const dark = darkRoom && cfg.display?.nightWhenDark === true;
  setNight((isNight(now) || dark) && Date.now() > wakeUntil);
  const idle = cfg.display?.idleReturnSec ?? 90;
  const held = ruleHold && curPage === ruleHold.page;
  if (idle > 0 && !held && Date.now() - lastTouch > idle * 1000 && (curPage !== 0 || sheet || !$('overview').hidden)) {
    closeSheet(); closeOverview(); goPage(0, true);
  }
  if (!nightOn) emit('tick');
  setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
}

// ---------------------------------------------------------------- data from the agent
function applyDisplay() {
  if (PREVIEW || !bridge) return;
  const d = cfg.display || {};
  try { bridge.setVolumeKeys && bridge.setVolumeKeys(d.volumeKeys !== false); } catch (_) {}
  try { bridge.setPinned && bridge.setPinned(d.pin === true); } catch (_) {}
  try { bridge.setHomeScreen && bridge.setHomeScreen(d.homeScreen === true); } catch (_) {}
  applyBrightness(true);
}

async function loadConfig() {
  if (PREVIEW) return;
  try {
    const r = await api('/config');
    const before = JSON.stringify(cfg);
    cfg = { ...DEFAULT_CFG, ...r.config };
    cfgVersion = r.version;
    if (JSON.stringify(cfg) !== before) {
      store.set('cfg', cfg);
      buildLayout();
      applyDisplay();
      loadWeather();
    }
  } catch (_) {}
}

async function loadQuotas() {
  try { D.quotas = await api('/quotas'); emit('quotas'); } catch (_) {}
}

function applyWork(w) {
  D.work = w;
  notifyTransitions(w.sessions || []);
  emit('work');
}

async function loadWork() {
  try { applyWork(await api('/work')); } catch (_) {}
}

async function loadProcs() {
  try { D.procs = await api('/procs?top=150'); emit('procs'); } catch (_) {}
}

async function loadPush() {
  try {
    const r = await api('/push');
    D.push = r.items || {};
    pushVersion = r.version;
    emit('push');
  } catch (_) {}
}

function setOnline(on) {
  document.body.classList.toggle('offline', !on);
  if (on && online !== true) { loadConfig(); loadQuotas(); loadWork(); loadPush(); loadApprovals(); }
  const changed = online !== on;
  online = on;
  if (changed) emit('state');
}

function applyState(s) {
  lastStateAt = Date.now();
  D.state = s;
  media = s.media ? { ...s.media, at: performance.now() } : null;
  setOnline(true);
  if (s.cfgVersion !== undefined && cfgVersion !== null && s.cfgVersion !== cfgVersion) loadConfig();
  if (s.pushVersion !== undefined && s.pushVersion !== pushVersion) loadPush();
  if (evSeq != null) for (const e of s.events || []) if (e.seq > evSeq) handleEvent(e);
  evSeq = Math.max(evSeq ?? 0, s.evSeq ?? 0);
  // the "back" event can be missed while offline; the list of active rules settles it
  if (ruleHold && Array.isArray(s.rules) && !s.rules.includes(ruleHold.rule) && Date.now() - ruleHold.at > 4000) endHold();
  {
    const pc = s.pc;
    if (pc) {
      pushHist('cpu', pc.cpu);
      pushHist('gpu', pc.gpu?.util);
      pushHist('ram', pc.ramUsedGb);
      pushHist('vram', pc.gpu?.vramTotal ? (pc.gpu.vramUsed / pc.gpu.vramTotal) * 100 : 0);
      pushHist('down', pc.netDownBps);
      pushHist('up', pc.netUpBps);
      pushHist('ping', s.ping?.ms);
      pushHist('gputemp', pc.gpu?.temp);
      pushHist('cputemp', pc.cpuTemp);
    }
  }
  emit('state');
}

// Live stream from the Android shell (see AgentStream.kt); polling below is the fallback when it is not running.
let streamOn = false;
let lastStateAt = 0;
window.onAgentStream = (event, data) => {
  if (event === 'open') { streamOn = true; return; }
  if (event === 'close') { streamOn = false; return; }
  let d;
  try { d = JSON.parse(data); } catch (_) { return; }
  if (event === 'state') applyState(d);
  else if (event === 'work') applyWork(d);
  else if (event === 'event' && d.seq > (evSeq ?? 0)) { evSeq = d.seq; handleEvent(d); }
};
const streaming = () => streamOn && Date.now() - lastStateAt < 3000;

async function poll() {
  if (!streaming()) {
    try { applyState(await api('/state' + (evSeq != null ? '?ev=' + evSeq : ''))); }
    catch (_) { if (!streaming()) setOnline(false); }
  }
  setTimeout(poll, 1000);
}

// ---------------------------------------------------------------- start
buildLayout();
applyDisplay();
tick();
loadWeather();
setInterval(loadWeather, 15 * 60_000);
setInterval(() => { if (!nightOn) emit('fast'); }, 250);
setInterval(() => { if (online && anyNeeds('quotas')) loadQuotas(); }, 30_000);
setInterval(() => { if (online && anyNeeds('work') && !streaming()) loadWork(); }, 3000);
setInterval(() => { if (online && pageOf('procs')) loadProcs(); if (online && sheet) loadSheet(); }, 2000);
setInterval(() => { if (online) loadConfig(); }, 60_000);
poll();

if (PREVIEW) {
  let weatherKey = '';
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.data?.type !== 'phonebox-preview') return;
    const c = e.data.config || {};
    // no night screen and no idle return in the preview
    cfg = { ...DEFAULT_CFG, ...c, night: { ...(c.night || {}), enabled: false }, display: { ...(c.display || {}), idleReturnSec: 0 } };
    buildLayout();
    const wk = JSON.stringify(cfg.weather);
    if (wk !== weatherKey) { weatherKey = wk; loadWeather(); }
    // the editor's page index counts hidden pages too; the panel only has the shown ones
    const list = cfg.pages || [], sel = list[e.data.page];
    const shown = (p) => p.enabled !== false && Array.isArray(p.widgets);
    const i = sel && shown(sel) ? list.slice(0, e.data.page).filter(shown).length : -1;
    if (i >= 0 && i !== curPage) goPage(i, true);
  });
  window.parent.postMessage({ type: 'phonebox-preview-ready' }, location.origin);
}
