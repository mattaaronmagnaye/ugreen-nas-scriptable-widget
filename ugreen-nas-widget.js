// UGREEN NAS Monitor — Scriptable widget (reads the Glances REST API)
// v1.0.0
// Glass-tile design for small (2x2), medium (4x2) and large (4x4) home-screen widgets,
// plus lock-screen widgets (circular, rectangular, inline).
// Every element has an exact size computed from the widget's real dimensions,
// so nothing depends on flexible layout.

const VERSION = "1.0.0";

const CONFIG = {
  baseUrl: "http://YOUR-NAS-IP:61208", // Glances address. Use your Tailscale IP for remote access.
  user: "",                          // Glances basic-auth username (leave "" if none)
  pass: "",                          // Glances basic-auth password (leave "" if none)
  name: "UGREEN NAS",                // title shown on medium and large
  volumes: ["/volume1"],             // mount points counted in "Disk"
  timeout: 8,
  warn: 70,                          // % -> amber (and a ▲ mark)
  crit: 90,                          // % -> red (and a ‼ mark)
  tempWarn: 65,                      // °C -> amber
  tempCrit: 80,                      // °C -> red
  historyHours: 12,                  // how much history the trend graph keeps
  metric: "cpu",                     // lock-screen circular widget: "cpu" | "ram" | "disk" | "temp"
  preview: "medium",                 // size shown when run inside Scriptable:
                                     // "small" | "medium" | "large" | "circular" | "rectangular" | "inline"
  // Where tapping a tile / pill opens. Empty = the Glances page (baseUrl).
  links: { storage: "", docker: "" },
  // If tiles look clipped or too narrow on your phone, set the real widget size in points, e.g.
  // sizeOverride: { small: [158, 158], medium: [338, 158], large: [338, 354] },
  sizeOverride: null,
};

// Per-widget settings without editing the script: long-press the widget -> Edit Widget -> Parameter.
// Example:  url=http://100.64.0.5:61208; name=Home NAS; metric=ram; volumes=/volume1,/volume2
(function applyParameter() {
  const raw = String(args.widgetParameter || "");
  raw.split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i < 1) return;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part.slice(i + 1).trim();
    if (!v) return;
    if (k === "url") CONFIG.baseUrl = v;
    else if (k === "name") CONFIG.name = v;
    else if (k === "user") CONFIG.user = v;
    else if (k === "pass") CONFIG.pass = v;
    else if (k === "metric") CONFIG.metric = v.toLowerCase();
    else if (k === "volumes") CONFIG.volumes = v.split(",").map(x => x.trim()).filter(Boolean);
  });
})();

// Forgive common typos: spaces, a trailing slash, or a slash before the port ("http://ip/:61208")
CONFIG.baseUrl = CONFIG.baseUrl.trim().replace(/\/+(?=:\d)/, "").replace(/\/+$/, "");

const THEME = {
  track: new Color("#ffffff", 0.12),
  text: Color.white(),
  dim: new Color("#ffffff", 0.6),
  ok:   ["#34e0a1", "#12b886"],   // [bright, deep]
  warn: ["#ffd166", "#ff9f0a"],
  crit: ["#ff6b6b", "#ff3b30"],
  accent: new Color("#9aa5ff"),
};

// ---------- storage (cache + history) ----------
const fm = FileManager.local();
const storePath = name => fm.joinPath(fm.documentsDirectory(), name);
function readJSON(name) {
  try {
    const p = storePath(name);
    return fm.fileExists(p) ? JSON.parse(fm.readString(p)) : null;
  } catch (e) { return null; }
}
function writeJSON(name, obj) {
  try { fm.writeString(storePath(name), JSON.stringify(obj)); } catch (e) { /* ignore */ }
}
const CACHE_FILE = "ugreen-nas-cache.json";
const HISTORY_FILE = "ugreen-nas-history.json";

function recordHistory(s) {
  const now = Date.now();
  const cutoff = now - CONFIG.historyHours * 3600 * 1000;
  let hist = (readJSON(HISTORY_FILE) || []).filter(h => h.t >= cutoff);
  const last = hist[hist.length - 1];
  if (!last || now - last.t > 4 * 60 * 1000) {
    hist.push({ t: now, cpu: s.cpu, ram: s.ram });
    writeJSON(HISTORY_FILE, hist);
  }
  return hist;
}

// ---------- data ----------
async function api(path) {
  const r = new Request(`${CONFIG.baseUrl}/api/4/${path}`);
  r.timeoutInterval = CONFIG.timeout;
  if (CONFIG.user) r.headers = { Authorization: "Basic " + btoa(`${CONFIG.user}:${CONFIG.pass}`) };
  // loadJSON() rejects bare JSON values like "271 days, 22:25:18" (uptime), so parse the text ourselves
  const text = await r.loadString();
  try {
    return JSON.parse(text);
  } catch (e) {
    // Usually the wrong address/port: the NAS (or another site) answered with a web page, not Glances data.
    throw new Error("Got a web page, not Glances data. Check baseUrl: http://IP:61208");
  }
}

// Glances' optional SMART plugin (experimental): pull a temperature attribute per drive.
function smartTemps(smart) {
  const out = [];
  (Array.isArray(smart) ? smart : []).forEach(d => {
    if (!d || typeof d !== "object") return;
    const name = String(d.DeviceName || d.name || "drive").replace(/^\/dev\//, "").split(" ")[0];
    let val = null;
    Object.keys(d).forEach(k => {
      const a = d[k];
      if (val == null && a && typeof a === "object" && /temp/i.test(String(a.name || ""))) {
        const m = String(a.raw != null ? a.raw : a.value).match(/\d+/);
        const n = m ? parseInt(m[0], 10) : NaN;
        if (n > 0 && n < 120) val = n;
      }
    });
    if (val != null) out.push({ label: name, value: val });
  });
  return out;
}

async function getStats() {
  const [cpu, mem, fs, sensors, uptime, net, containers, smart] = await Promise.all([
    api("cpu"), api("mem"), api("fs"),
    api("sensors").catch(() => []),
    api("uptime").catch(() => ""),
    api("network").catch(() => []),
    api("containers").catch(() => null),   // needs the docker socket mounted into Glances
    api("smart").catch(() => null),        // needs Glances' smart plugin (optional)
  ]);

  const list = Array.isArray(containers) ? containers : [];
  const isUp = c => /^(running|healthy|up)/i.test(c.status || "");
  const docker = list.length
    ? { running: list.filter(isUp).length, total: list.length, down: list.filter(c => !isUp(c)).map(c => ({ name: c.name, status: c.status })) }
    : null;

  let vols = fs.filter(f => CONFIG.volumes.includes(f.mnt_point));
  if (!vols.length) vols = [fs.sort((a, b) => b.size - a.size)[0]];
  const size = vols.reduce((s, v) => s + v.size, 0);
  const used = vols.reduce((s, v) => s + v.used, 0);

  const temps = (sensors || []).filter(s => /temperature/.test(s.type) && typeof s.value === "number")
    .map(t => ({ label: t.label, value: t.value, type: t.type }));
  const soc = temps.filter(s => /^soc_thermal/i.test(s.label));
  const cpuT = soc.length ? soc : temps.filter(s => /package|cpu|core|tctl|k10temp/i.test(s.label));
  const drives = temps.filter(s => s.type === "temperature_hdd" || /drive|nvme|composite|hdd|sd[a-z]/i.test(s.label))
    .concat(smartTemps(smart));
  const allTemps = temps.concat(smartTemps(smart));
  const max = a => (a.length ? Math.max(...a.map(s => s.value)) : null);

  const nics = (net || []).filter(n => n.is_up !== false && !/^(lo|docker|veth|br-)/.test(n.interface_name));
  const rx = nics.reduce((s, n) => s + (n.bytes_recv_rate_per_sec || 0), 0);
  const tx = nics.reduce((s, n) => s + (n.bytes_sent_rate_per_sec || 0), 0);

  return {
    cpu: cpu.total, cores: cpu.cpucore || null,
    ram: mem.percent, ramUsed: mem.used, ramTotal: mem.total,
    disk: size ? (used / size) * 100 : 0, diskUsed: used, diskTotal: size,
    cpuTemp: max(cpuT), diskTemp: max(drives),
    temps: allTemps.map(t => ({ label: t.label, value: t.value })),
    uptimeSec: uptimeSeconds(uptime),
    rx, tx, docker,
  };
}

// Fresh stats, or the last good reading (flagged stale) when the NAS can't be reached.
async function loadStats() {
  try {
    const s = await getStats();
    writeJSON(CACHE_FILE, { url: CONFIG.baseUrl, t: Date.now(), s });
    return { s, staleSince: null, hist: recordHistory(s) };
  } catch (e) {
    const c = readJSON(CACHE_FILE);
    if (c && c.url === CONFIG.baseUrl && c.s) {
      const hist = (readJSON(HISTORY_FILE) || []);
      return { s: c.s, staleSince: c.t, hist };
    }
    throw e;
  }
}

// ---------- helpers ----------
const level = p => (p >= CONFIG.crit ? THEME.crit : p >= CONFIG.warn ? THEME.warn : THEME.ok);
const tempLevel = t => (t >= CONFIG.tempCrit ? THEME.crit : t >= CONFIG.tempWarn ? THEME.warn : THEME.ok);
// Marks survive iOS's tinted/clear mode, where colour is stripped
const markOf = pal => (pal === THEME.crit ? " ‼" : pal === THEME.warn ? " ▲" : "");

const fmtRate = b => {
  const u = ["B", "K", "M", "G"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b >= 10 || i === 0 ? 0 : 1)}${u[i]}/s`;
};
// Glances versions return uptime as text ("3 days, 4:05:06"), a number of seconds, or {seconds: N}.
function uptimeSeconds(raw) {
  if (raw == null) return null;
  if (typeof raw === "number") return raw;
  if (typeof raw === "object") {
    for (const k of ["seconds", "uptime", "value"]) {
      if (raw[k] != null) { const v = uptimeSeconds(raw[k]); if (v != null) return v; }
    }
    return null;
  }
  const str = String(raw);
  const m = /(?:(\d+) days?, )?(\d+):(\d+)(?::(\d+))?/.exec(str);
  if (m) return (+m[1] || 0) * 86400 + (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4] || 0);
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}
const splitUp = sec => {
  sec = Math.floor(sec);
  return { d: Math.floor(sec / 86400), h: Math.floor((sec % 86400) / 3600), m: Math.floor((sec % 3600) / 60), s: sec % 60 };
};
// Short: "12d 4h" (or "4h 5m" under a day). Full: "12d 4h 5m 6s" (days omitted when zero).
const fmtUptime = sec => {
  if (sec == null) return "";
  const u = splitUp(sec);
  return u.d ? `${u.d}d ${u.h}h` : `${u.h}h ${u.m}m`;
};
// Tiny (small widget header): "271d", or "4h 5m" under a day
const fmtUptimeTiny = sec => {
  if (sec == null) return "";
  const u = splitUp(sec);
  return u.d ? `${u.d}d` : `${u.h}h ${u.m}m`;
};
const fmtUptimeFull = sec => {
  if (sec == null) return "";
  const u = splitUp(sec);
  return [u.d ? `${u.d}d` : null, `${u.h}h`, `${u.m}m`, `${u.s}s`].filter(Boolean).join(" ");
};
const fmtAge = t => {
  const m = Math.max(1, Math.round((Date.now() - t) / 60000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
// "2.6/3.6T": used and total expressed in total's unit
const fmtPair = (used, total) => {
  const u = ["B", "K", "M", "G", "T", "P"];
  let i = 0, t = total;
  while (t >= 1024 && i < u.length - 1) { t /= 1024; i++; }
  const d = Math.pow(1024, i);
  const f = x => (x / d).toFixed(x / d >= 100 ? 0 : 1);
  return `${f(used)}/${f(total)}${u[i]}`;
};
const prettyLabel = l => l.replace(/_thermal.*$/i, "").replace(/[_\s]+\d*$/, "").replace(/_/g, " ").toUpperCase();

function mix(a, b, t) {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  const c = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return new Color("#" + c(r1, r2) + c(g1, g2) + c(b1, b2));
}

// ---------- widget geometry ----------
// Real widget sizes in points, keyed by the phone's long screen side:
// [small (square), medium width, large height]. Medium height = small; large width = medium width.
const SIZE_TABLE = {
  956: [170, 364, 382], 932: [170, 364, 382], 926: [170, 364, 382], 896: [169, 360, 379],
  874: [162, 346, 366], 852: [158, 338, 354], 844: [158, 338, 354], 812: [155, 329, 345],
  736: [157, 348, 357], 667: [148, 321, 324], 568: [141, 292, 311],
};
function widgetSize(family) {
  if (CONFIG.sizeOverride && CONFIG.sizeOverride[family]) {
    const [w, h] = CONFIG.sizeOverride[family];
    return { w, h };
  }
  let row;
  if (Device.isPad()) {
    row = [155, 342, 342];                 // conservative iPad default
  } else {
    const sc = Device.screenSize();
    const long = Math.max(sc.width, sc.height);
    const keys = Object.keys(SIZE_TABLE).map(Number);
    const best = keys.reduce((a, b) => (Math.abs(b - long) < Math.abs(a - long) ? b : a));
    row = SIZE_TABLE[best];
  }
  const [s, m, l] = row;
  if (family === "small") return { w: s, h: s };
  if (family === "large") return { w: m, h: l };
  return { w: m, h: s };
}

// ---------- drawing ----------
// Soft colour glows on near-black (shown on normal home screens; iOS replaces it in clear/tinted mode)
function drawGlowBg(W, H) {
  const ctx = new DrawContext();
  ctx.size = new Size(W, H);
  ctx.opaque = true;
  ctx.respectScreenScale = false;
  ctx.setFillColor(new Color("#0b0d16"));
  ctx.fillRect(new Rect(0, 0, W, H));
  const m = Math.min(W, H);
  const glow = (cx, cy, rad, hex, a) => {
    for (let i = 0; i < 24; i++) {
      const r = rad * (1 - i / 24);
      ctx.setFillColor(new Color(hex, a));
      ctx.fillEllipse(new Rect(cx - r, cy - r, r * 2, r * 2));
    }
  };
  glow(W * 0.1, H * 0.1, m * 0.68, "#5b6cff", 0.026);
  glow(W * 0.95, H * 0.97, m * 0.72, "#14d6a6", 0.022);
  glow(W * 0.97, H * 0.1, m * 0.4, "#b45cff", 0.02);
  return ctx.getImage();
}

// Segmented LED-style meter drawn at an exact size (w x h points)
function drawMeter(pct, pal, w, h) {
  const k = 3;
  const W = Math.round(w * k), H = Math.round(h * k);
  const ctx = new DrawContext();
  ctx.size = new Size(W, H);
  ctx.opaque = false;
  ctx.respectScreenScale = false;
  const n = Math.max(8, Math.round(w / 6));
  const gap = 1.6 * k;
  const segW = (W - gap * (n - 1)) / n;
  const lit = pct > 0 ? Math.max(1, Math.round((Math.min(pct, 100) / 100) * n)) : 0;
  for (let i = 0; i < n; i++) {
    const p = new Path();
    p.addRoundedRect(new Rect(i * (segW + gap), 0, segW, H), H / 2, H / 2);
    ctx.setFillColor(i < lit ? mix(pal[1], pal[0], lit > 1 ? i / (lit - 1) : 1) : THEME.track);
    ctx.addPath(p);
    ctx.fillPath();
  }
  return ctx.getImage();
}

// Line graph of 0-100 series, each { data: [...], color: Color }
function drawSpark(series, w, h) {
  const k = 3;
  const W = Math.round(w * k), H = Math.round(h * k);
  const ctx = new DrawContext();
  ctx.size = new Size(W, H);
  ctx.opaque = false;
  ctx.respectScreenScale = false;
  ctx.setFillColor(new Color("#ffffff", 0.08));
  ctx.fillRect(new Rect(0, H - 1, W, 1));
  ctx.setLineWidth(1.8 * k);
  series.forEach(sr => {
    const d = sr.data;
    if (d.length < 2) return;
    const p = new Path();
    d.forEach((v, i) => {
      const pt = new Point((i / (d.length - 1)) * W, H - 2 * k - (Math.min(100, Math.max(0, v)) / 100) * (H - 4 * k));
      i === 0 ? p.move(pt) : p.addLine(pt);
    });
    ctx.setStrokeColor(sr.color);
    ctx.addPath(p);
    ctx.strokePath();
  });
  return ctx.getImage();
}

// Ring gauge for the lock screen: plain white arc + centre text (lock screen is monochrome)
function drawRing(pct, text, d) {
  const k = 3, D = d * k;
  const ctx = new DrawContext();
  ctx.size = new Size(D, D);
  ctx.opaque = false;
  ctx.respectScreenScale = false;
  const lw = D * 0.11, r = D / 2 - lw / 2 - 1, c = D / 2;
  const pt = a => new Point(c + r * Math.cos(a), c + r * Math.sin(a));
  const start = -Math.PI / 2;
  const arc = (frac, col) => {
    const p = new Path();
    const n = Math.max(2, Math.round(frac * 100));
    for (let i = 0; i <= n; i++) {
      const q = pt(start + (i / n) * frac * Math.PI * 2);
      i === 0 ? p.move(q) : p.addLine(q);
    }
    ctx.setStrokeColor(col);
    ctx.setLineWidth(lw);
    ctx.addPath(p);
    ctx.strokePath();
  };
  arc(0.9999, new Color("#ffffff", 0.25));
  arc(Math.max(0.02, Math.min(pct, 100) / 100), Color.white());
  ctx.setTextAlignedCenter();
  ctx.setTextColor(Color.white());
  const fs = D * 0.26;
  ctx.setFont(Font.boldRoundedSystemFont(fs));
  ctx.drawTextInRect(text, new Rect(0, c - fs * 0.62, D, fs * 1.4));
  return ctx.getImage();
}

// ---------- components ----------
function glassify(stack, radius) {
  stack.cornerRadius = radius;
  stack.backgroundColor = new Color("#ffffff", 0.10);
  stack.borderWidth = 0.6;
  stack.borderColor = new Color("#ffffff", 0.22);
}

// A glass cell of an exact size with insets done via spacers; returns the inner column.
function glassCell(parent, w, h, padX, padY, radius, url) {
  const cell = parent.addStack();
  cell.layoutVertically();
  cell.size = new Size(w, h);
  glassify(cell, radius);
  if (url) cell.url = url;
  cell.addSpacer(padY);
  const mid = cell.addStack();
  mid.layoutHorizontally();
  mid.addSpacer(padX);
  const col = mid.addStack();
  col.layoutVertically();
  col.size = new Size(w - 2 * padX, h - 2 * padY);
  mid.addSpacer(padX);
  cell.addSpacer(padY);
  return col;
}

function addPill(parent, symbol, text, pal, url) {
  const pill = parent.addStack();
  pill.setPadding(3, 8, 3, 8);
  pill.cornerRadius = 10;
  pill.backgroundColor = new Color(pal ? pal[0] : "#ffffff", 0.14);
  pill.centerAlignContent();
  if (url) pill.url = url;
  const t = pill.addText(`${symbol} ${text}`);
  t.font = Font.semiboldRoundedSystemFont(10);
  t.textColor = pal ? new Color(pal[0]) : THEME.dim;
  t.lineLimit = 1;
  return pill;
}

// lvl: 0 small, 1 medium, 2 large
function addTile(parent, w, h, lvl, label, valueText, pct, pal, detail, url) {
  const padX = [8, 9, 12][lvl], padY = [5, 8, 6][lvl];
  const col = glassCell(parent, w, h, padX, padY, [14, 16, 20][lvl], url);
  const innerW = w - 2 * padX;

  const l = col.addText(label + markOf(pal));
  l.font = Font.heavyRoundedSystemFont([8, 9, 10][lvl]);
  l.textColor = new Color(pal[0]);
  const v = col.addText(valueText);
  v.font = Font.boldRoundedSystemFont([18, 24, 22][lvl]);
  v.textColor = THEME.text;
  v.minimumScaleFactor = 0.6;
  v.lineLimit = 1;
  if (detail) {
    const d = col.addText(detail);
    d.font = Font.mediumRoundedSystemFont([8, 8, 9][lvl]);
    d.textColor = THEME.dim;
    d.minimumScaleFactor = 0.6;
    d.lineLimit = 1;
  }
  col.addSpacer();
  const mh = [3.5, 4, 4][lvl];
  const img = col.addImage(drawMeter(pct, pal, innerW, mh));
  img.imageSize = new Size(innerW, mh);
}

// Temperature list card (large): label on the left, value on the right, hottest first
function addTempCard(parent, w, h, temps) {
  const padX = 10, padY = 7, rowH = 14;
  const col = glassCell(parent, w, h, padX, padY, 18);
  const innerW = w - 2 * padX;

  const title = col.addText("TEMPERATURES");
  title.font = Font.heavyRoundedSystemFont(9);
  title.textColor = THEME.accent;
  col.addSpacer(4);

  const fit = Math.max(1, Math.floor((h - 2 * padY - 11 - 4) / rowH));
  const shown = temps.slice(0, fit);
  shown.forEach(t => {
    const pal = tempLevel(t.value);
    const row = col.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();
    row.size = new Size(innerW, rowH);
    const lt = row.addText(prettyLabel(t.label));
    lt.font = Font.heavyRoundedSystemFont(9);
    lt.textColor = THEME.dim;
    lt.lineLimit = 1;
    row.addSpacer();
    const v = row.addText(`${Math.round(t.value)}°C${markOf(pal)}`);
    v.font = Font.semiboldRoundedSystemFont(10);
    v.textColor = new Color(pal[0]);
  });
  if (!shown.length) {
    const none = col.addText("No sensors reported");
    none.font = Font.systemFont(10);
    none.textColor = THEME.dim;
  }
}

// Trend + containers card (large)
function addTrendCard(parent, w, h, hist, docker, dockerUrl) {
  const padX = 10, padY = 7;
  const col = glassCell(parent, w, h, padX, padY, 18, dockerUrl);
  const innerW = w - 2 * padX;

  const title = col.addText(`LAST ${CONFIG.historyHours}H`);
  title.font = Font.heavyRoundedSystemFont(9);
  title.textColor = THEME.accent;
  col.addSpacer(3);

  const sparkH = 32;
  if (hist.length >= 3) {
    const img = col.addImage(drawSpark([
      { data: hist.map(x => x.ram), color: new Color(THEME.warn[0]) },
      { data: hist.map(x => x.cpu), color: new Color(THEME.ok[0]) },
    ], innerW, sparkH));
    img.imageSize = new Size(innerW, sparkH);
    const leg = col.addText("● CPU   ● RAM");
    leg.font = Font.mediumRoundedSystemFont(8);
    leg.textColor = THEME.dim;
  } else {
    const t = col.addText("Collecting data…");
    t.font = Font.mediumRoundedSystemFont(9);
    t.textColor = THEME.dim;
    col.addSpacer(10);
  }
  col.addSpacer(4);

  if (docker) {
    const ok = docker.running === docker.total;
    const t = col.addText(ok ? `🐳 all ${docker.total} containers up` : `🐳 ${docker.running}/${docker.total} up`);
    t.font = Font.semiboldRoundedSystemFont(9);
    t.textColor = new Color((ok ? THEME.ok : THEME.warn)[0]);
    t.lineLimit = 1;
    t.minimumScaleFactor = 0.7;
    docker.down.slice(0, 2).forEach(c => {
      const d = col.addText(`✕ ${c.name} (${c.status})`);
      d.font = Font.mediumRoundedSystemFont(8);
      d.textColor = THEME.dim;
      d.lineLimit = 1;
      d.minimumScaleFactor = 0.7;
    });
  } else {
    const t = col.addText("Docker: not connected");
    t.font = Font.mediumRoundedSystemFont(8);
    t.textColor = THEME.dim;
  }
}

// ---------- home-screen widget ----------
async function buildWidget(family) {
  const w = new ListWidget();
  w.url = CONFIG.baseUrl;
  w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);

  const small = family === "small";
  const large = family === "large";
  const lvl = small ? 0 : large ? 2 : 1;

  const { w: W, h: H } = widgetSize(family);
  w.backgroundImage = drawGlowBg(W * 3, H * 3);

  const padX = small ? 10 : 14, padY = small ? 10 : 12;
  w.setPadding(padY, padX, padY, padX);
  const innerW = W - 2 * padX - 2;          // 2pt safety margin
  const innerH = H - 2 * padY - 2;
  const pillH = 18;

  const head = w.addStack();
  head.layoutHorizontally();
  head.centerAlignContent();
  head.size = new Size(innerW, pillH);
  if (!small) {
    const title = head.addText(CONFIG.name || "NAS");
    title.font = Font.heavyRoundedSystemFont(13);
    title.textColor = THEME.text;
  }
  head.addSpacer();

  if (CONFIG.baseUrl.includes("YOUR-NAS-IP")) {
    w.addSpacer(8);
    const m = w.addText("Setup needed:\nset baseUrl in the script or in the widget Parameter (url=http://IP:61208)");
    m.font = Font.systemFont(11);
    m.textColor = THEME.dim;
    return w;
  }

  let r;
  try {
    r = await loadStats();
  } catch (e) {
    addPill(head, "●", "OFFLINE", THEME.crit);
    w.addSpacer(8);
    const msg = w.addText("Can't reach NAS.\n" + String(e.message || e).slice(0, 80));
    msg.font = Font.systemFont(11);
    msg.textColor = THEME.dim;
    return w;
  }
  const { s, staleSince, hist } = r;

  if (staleSince) addPill(head, "⏱", `${fmtAge(staleSince)} ago`, THEME.warn);
  else addPill(head, "●", small ? (fmtUptimeTiny(s.uptimeSec) || "online") : "online", THEME.ok);
  if (s.docker) {
    head.addSpacer(5);
    addPill(head, "🐳", `${s.docker.running}/${s.docker.total}`, s.docker.running === s.docker.total ? THEME.ok : THEME.warn,
      CONFIG.links.docker || undefined);
  } else if (small) {
    head.addSpacer(5);
    addPill(head, "↓", fmtRate(s.rx), null);
  }

  const tempPct = s.cpuTemp != null ? Math.min(100, (s.cpuTemp / CONFIG.tempCrit) * 100) : 0;
  const d = (x) => (small ? null : x);
  const tiles = [
    ["CPU", `${Math.round(s.cpu)}%`, s.cpu, level(s.cpu), d(s.cores ? `${s.cores} cores` : " ")],
    ["RAM", `${Math.round(s.ram)}%`, s.ram, level(s.ram), d(fmtPair(s.ramUsed, s.ramTotal))],
    ["DISK", `${Math.round(s.disk)}%`, s.disk, level(s.disk), d(fmtPair(s.diskUsed, s.diskTotal)), CONFIG.links.storage || undefined],
    s.cpuTemp != null
      ? ["TEMP", `${Math.round(s.cpuTemp)}°`, tempPct, tempLevel(s.cpuTemp), d("SoC")]
      : ["NET ↓", fmtRate(s.rx), 0, THEME.ok, d(`↑ ${fmtRate(s.tx)}`)],
  ];

  // ===== SMALL: 2x2 tiles =====
  if (small) {
    const gap = 5;
    const tw = Math.floor((innerW - gap) / 2);
    const th = Math.floor((innerH - pillH - gap - gap) / 2);
    w.addSpacer(gap);
    for (let i = 0; i < 2; i++) {
      const row = w.addStack();
      row.layoutHorizontally();
      addTile(row, tw, th, lvl, ...tiles[i * 2]);
      row.addSpacer(gap);
      addTile(row, tw, th, lvl, ...tiles[i * 2 + 1]);
      if (i === 0) w.addSpacer(gap);
    }
    return w;
  }

  // ===== MEDIUM: 4 tiles in a row =====
  if (!large) {
    const gap = 6;
    const tw = Math.floor((innerW - gap * 3) / 4);
    const th = innerH - pillH - 6 - pillH - 6;
    w.addSpacer(6);
    const row = w.addStack();
    row.layoutHorizontally();
    tiles.forEach((t, i) => {
      if (i) row.addSpacer(gap);
      addTile(row, tw, th, lvl, ...t);
    });
  } else {
    // ===== LARGE: 2x2 tiles, then temperatures + trend/containers cards =====
    const gap = 6;
    const tw = Math.floor((innerW - gap) / 2);
    const avail = innerH - pillH - 8 - 6 - pillH;          // below the header, above the footer
    const th = Math.max(60, Math.min(78, Math.floor((avail - 118 - 2 * gap) / 2)));
    const cardH = Math.max(90, avail - 2 * th - 2 * gap);
    w.addSpacer(8);
    for (let i = 0; i < 2; i++) {
      const row = w.addStack();
      row.layoutHorizontally();
      addTile(row, tw, th, lvl, ...tiles[i * 2]);
      row.addSpacer(gap);
      addTile(row, tw, th, lvl, ...tiles[i * 2 + 1]);
      w.addSpacer(gap);
    }
    const cards = w.addStack();
    cards.layoutHorizontally();
    const temps = [...(s.temps || [])].sort((a, b) => b.value - a.value);
    addTempCard(cards, tw, cardH, temps);
    cards.addSpacer(gap);
    addTrendCard(cards, tw, cardH, hist, s.docker, CONFIG.links.docker || undefined);
  }

  w.addSpacer();

  // footer: network speed on the left, (drive temp and) full uptime on the right
  const foot = w.addStack();
  foot.layoutHorizontally();
  foot.centerAlignContent();
  foot.size = new Size(innerW, pillH);
  addPill(foot, "↓", fmtRate(s.rx), null);
  foot.addSpacer(5);
  addPill(foot, "↑", fmtRate(s.tx), null);
  foot.addSpacer();
  if (s.diskTemp != null) {
    addPill(foot, "💾", `${Math.round(s.diskTemp)}°C${markOf(tempLevel(s.diskTemp))}`, tempLevel(s.diskTemp));
    foot.addSpacer(5);
  }
  // with a drive-temp pill present, use the shorter uptime so everything still fits
  const up = s.diskTemp != null ? fmtUptime(s.uptimeSec) : fmtUptimeFull(s.uptimeSec);
  if (up) addPill(foot, "up", up, null);
  return w;
}

// ---------- lock-screen widgets ----------
async function buildAccessory(family) {
  const w = new ListWidget();
  w.url = CONFIG.baseUrl;
  w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
  w.setPadding(0, 0, 0, 0);

  let r = null;
  if (!CONFIG.baseUrl.includes("YOUR-NAS-IP")) {
    try { r = await loadStats(); } catch (e) { r = null; }
  }
  const s = r ? r.s : null;
  const stale = r && r.staleSince ? " ⏱" : "";

  if (family === "accessoryInline") {
    const t = w.addText(s ? `NAS ${Math.round(s.cpu)}% · RAM ${Math.round(s.ram)}%${s.cpuTemp != null ? ` · ${Math.round(s.cpuTemp)}°` : ""}${stale}` : "NAS offline");
    return w;
  }

  if (family === "accessoryCircular") {
    const m = CONFIG.metric;
    let pct = 0, text = "--", lab = m.toUpperCase();
    if (s) {
      if (m === "ram") { pct = s.ram; text = `${Math.round(s.ram)}`; }
      else if (m === "disk") { pct = s.disk; text = `${Math.round(s.disk)}`; }
      else if (m === "temp") { pct = s.cpuTemp != null ? (s.cpuTemp / CONFIG.tempCrit) * 100 : 0; text = s.cpuTemp != null ? `${Math.round(s.cpuTemp)}°` : "--"; }
      else { pct = s.cpu; text = `${Math.round(s.cpu)}`; lab = "CPU"; }
    }
    const row = w.addStack();
    row.addSpacer();
    const img = row.addImage(drawRing(pct, text, 52));
    img.imageSize = new Size(52, 52);
    row.addSpacer();
    return w;
  }

  // accessoryRectangular
  const t1 = w.addText(s ? `NAS${stale}${s.docker ? `  🐳 ${s.docker.running}/${s.docker.total}` : ""}` : "NAS offline");
  t1.font = Font.boldSystemFont(12);
  if (s) {
    const t2 = w.addText(`CPU ${Math.round(s.cpu)}%${markOf(level(s.cpu))}  RAM ${Math.round(s.ram)}%${markOf(level(s.ram))}`);
    t2.font = Font.systemFont(12);
    const t3 = w.addText(`DISK ${Math.round(s.disk)}%${markOf(level(s.disk))}${s.cpuTemp != null ? `  ${Math.round(s.cpuTemp)}°C` : ""}`);
    t3.font = Font.systemFont(12);
    const bar = w.addImage(drawMeter(s.ram, ["#ffffff", "#ffffff"], 120, 4));
    bar.imageSize = new Size(120, 4);
  }
  return w;
}

// ---------- run ----------
const FAMILIES = {
  small: "small", medium: "medium", large: "large",
  circular: "accessoryCircular", rectangular: "accessoryRectangular", inline: "accessoryInline",
};
const family = config.runsInWidget ? (config.widgetFamily || "medium") : (FAMILIES[CONFIG.preview] || "medium");
const isAccessory = /^accessory/.test(family);

const widget = isAccessory ? await buildAccessory(family) : await buildWidget(family);
if (config.runsInWidget) {
  Script.setWidget(widget);
} else if (family === "small") {
  await widget.presentSmall();
} else if (family === "large") {
  await widget.presentLarge();
} else if (family === "accessoryCircular" && widget.presentAccessoryCircular) {
  await widget.presentAccessoryCircular();
} else if (family === "accessoryRectangular" && widget.presentAccessoryRectangular) {
  await widget.presentAccessoryRectangular();
} else if (family === "accessoryInline" && widget.presentAccessoryInline) {
  await widget.presentAccessoryInline();
} else {
  await widget.presentMedium();
}
Script.complete();
