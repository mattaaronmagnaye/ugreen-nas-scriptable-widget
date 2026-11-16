// UGREEN NAS Monitor — Scriptable widget (reads the Glances REST API)
// Glass-tile design for small (2x2), medium (4x2) and large (4x4).
// Every element has an exact size computed from the widget's real dimensions,
// so nothing depends on flexible layout.

const CONFIG = {
  baseUrl: "http://YOUR-NAS-IP:61208", // swap to your Tailscale IP for remote use
  user: "",                          // Glances basic-auth user (leave "" if none)
  pass: "",                          // Add password if any
  name: "",                          // Add username if any
  volumes: ["/volume1"],             // mount points to include in "Disk"
  timeout: 8,
  warn: 70,                          // % -> amber
  crit: 90,                          // % -> red
  tempWarn: 65,                      // °C -> amber
  tempCrit: 80,                      // °C -> red
  preview: "medium",                 // size shown when run inside Scriptable: "small" | "medium" | "large"
  // If tiles look clipped or too narrow on your phone, set the real widget size in points, e.g.
  // sizeOverride: { small: [158, 158], medium: [338, 158], large: [338, 354] },
  sizeOverride: null,
};

const THEME = {
  track: new Color("#ffffff", 0.12),
  text: Color.white(),
  dim: new Color("#ffffff", 0.6),
  ok:   ["#34e0a1", "#12b886"],   // [bright, deep]
  warn: ["#ffd166", "#ff9f0a"],
  crit: ["#ff6b6b", "#ff3b30"],
  accent: new Color("#9aa5ff"),
};

// ---------- data ----------
async function api(path) {
  const r = new Request(`${CONFIG.baseUrl}/api/4/${path}`);
  r.timeoutInterval = CONFIG.timeout;
  if (CONFIG.user) r.headers = { Authorization: "Basic " + btoa(`${CONFIG.user}:${CONFIG.pass}`) };
  return await r.loadJSON();
}

async function getStats() {
  const [cpu, mem, fs, sensors, uptime, net, containers] = await Promise.all([
    api("cpu"), api("mem"), api("fs"),
    api("sensors").catch(() => []),
    api("uptime").catch(() => ""),
    api("network").catch(() => []),
    api("containers").catch(() => null),   // needs the docker socket mounted into Glances
  ]);
  const docker = Array.isArray(containers) && containers.length
    ? { running: containers.filter(c => /^(running|healthy|up)/i.test(c.status || "")).length, total: containers.length }
    : null;

  let vols = fs.filter(f => CONFIG.volumes.includes(f.mnt_point));
  if (!vols.length) vols = [fs.sort((a, b) => b.size - a.size)[0]];
  const size = vols.reduce((s, v) => s + v.size, 0);
  const used = vols.reduce((s, v) => s + v.used, 0);

  const temps = (sensors || []).filter(s => /temperature/.test(s.type) && typeof s.value === "number");
  const soc = temps.filter(s => /^soc_thermal/i.test(s.label));
  const cpuT = soc.length ? soc : temps.filter(s => /package|cpu|core|tctl|k10temp/i.test(s.label));
  const diskT = temps.filter(s => s.type === "temperature_hdd" || /drive|nvme|composite|hdd|sd[a-z]/i.test(s.label));
  const max = a => (a.length ? Math.max(...a.map(s => s.value)) : null);

  const nics = (net || []).filter(n => n.is_up !== false && !/^(lo|docker|veth|br-)/.test(n.interface_name));
  const rx = nics.reduce((s, n) => s + (n.bytes_recv_rate_per_sec || 0), 0);
  const tx = nics.reduce((s, n) => s + (n.bytes_sent_rate_per_sec || 0), 0);

  return {
    cpu: cpu.total, cores: cpu.cpucore || null,
    ram: mem.percent, ramUsed: mem.used, ramTotal: mem.total,
    disk: size ? (used / size) * 100 : 0, diskUsed: used, diskTotal: size,
    cpuTemp: max(cpuT), diskTemp: max(diskT),
    temps: temps.map(t => ({ label: t.label, value: t.value })),
    uptime: typeof uptime === "string" ? uptime : "",
    rx, tx, docker,
  };
}

// ---------- helpers ----------
const level = p => (p >= CONFIG.crit ? THEME.crit : p >= CONFIG.warn ? THEME.warn : THEME.ok);
const tempLevel = t => (t >= CONFIG.tempCrit ? THEME.crit : t >= CONFIG.tempWarn ? THEME.warn : THEME.ok);

const fmtRate = b => {
  const u = ["B", "K", "M", "G"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b >= 10 || i === 0 ? 0 : 1)}${u[i]}/s`;
};
const fmtUptime = s => {
  const m = /(?:(\d+) days?, )?(\d+):(\d+)/.exec(s || "");
  if (!m) return s || "";
  return m[1] ? `${m[1]}d ${m[2]}h` : `${m[2]}h ${m[3]}m`;
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

// ---------- components ----------
function glassify(stack, radius) {
  stack.cornerRadius = radius;
  stack.backgroundColor = new Color("#ffffff", 0.10);
  stack.borderWidth = 0.6;
  stack.borderColor = new Color("#ffffff", 0.22);
}

// A glass cell of an exact size with insets done via spacers; returns the inner column.
function glassCell(parent, w, h, padX, padY, radius) {
  const cell = parent.addStack();
  cell.layoutVertically();
  cell.size = new Size(w, h);
  glassify(cell, radius);
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

function addPill(parent, symbol, text, pal) {
  const pill = parent.addStack();
  pill.setPadding(3, 8, 3, 8);
  pill.cornerRadius = 10;
  pill.backgroundColor = new Color(pal ? pal[0] : "#ffffff", 0.14);
  pill.centerAlignContent();
  const t = pill.addText(`${symbol} ${text}`);
  t.font = Font.semiboldRoundedSystemFont(10);
  t.textColor = pal ? new Color(pal[0]) : THEME.dim;
  t.lineLimit = 1;
  return pill;
}

// lvl: 0 small, 1 medium, 2 large
function addTile(parent, w, h, lvl, label, valueText, pct, pal, detail) {
  const padX = [8, 9, 12][lvl], padY = [5, 8, 9][lvl];
  const col = glassCell(parent, w, h, padX, padY, [14, 16, 20][lvl]);
  const innerW = w - 2 * padX;

  const l = col.addText(label);
  l.font = Font.heavyRoundedSystemFont([8, 9, 10][lvl]);
  l.textColor = new Color(pal[0]);
  const v = col.addText(valueText);
  v.font = Font.boldRoundedSystemFont([18, 24, 30][lvl]);
  v.textColor = THEME.text;
  v.minimumScaleFactor = 0.6;
  v.lineLimit = 1;
  if (detail) {
    const d = col.addText(detail);
    d.font = Font.mediumRoundedSystemFont([8, 8, 10][lvl]);
    d.textColor = THEME.dim;
    d.minimumScaleFactor = 0.6;
    d.lineLimit = 1;
  }
  col.addSpacer();
  const mh = [3.5, 4, 5][lvl];
  const img = col.addImage(drawMeter(pct, pal, innerW, mh));
  img.imageSize = new Size(innerW, mh);
}

// Temperature list in a glass card, hottest first; as many rows as fit the card height
function addTempCard(parent, w, h, temps) {
  const padX = 12, padY = 8, rowH = 15;
  const col = glassCell(parent, w, h, padX, padY, 20);
  const innerW = w - 2 * padX;

  const title = col.addText("TEMPERATURES");
  title.font = Font.heavyRoundedSystemFont(9);
  title.textColor = THEME.accent;
  col.addSpacer(5);

  const fit = Math.max(1, Math.floor((h - 2 * padY - 11 - 5) / rowH));
  const shown = temps.slice(0, fit);
  const labelW = 76, valueW = 42, gaps = 12;
  const meterW = innerW - labelW - valueW - gaps;

  shown.forEach(t => {
    const pal = tempLevel(t.value);
    const row = col.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();
    row.size = new Size(innerW, rowH);

    const ls = row.addStack();
    ls.size = new Size(labelW, 0);
    const lt = ls.addText(prettyLabel(t.label));
    lt.font = Font.heavyRoundedSystemFont(9);
    lt.textColor = THEME.dim;
    lt.lineLimit = 1;
    ls.addSpacer();

    row.addSpacer(6);
    const img = row.addImage(drawMeter((t.value / CONFIG.tempCrit) * 100, pal, meterW, 5));
    img.imageSize = new Size(meterW, 5);
    row.addSpacer(6);

    const vs = row.addStack();
    vs.size = new Size(valueW, 0);
    vs.addSpacer();
    const v = vs.addText(`${Math.round(t.value)}°C`);
    v.font = Font.semiboldRoundedSystemFont(10);
    v.textColor = new Color(pal[0]);
  });
  if (!shown.length) {
    const none = col.addText("No sensors reported");
    none.font = Font.systemFont(10);
    none.textColor = THEME.dim;
  }
}

// ---------- widget ----------
async function buildWidget() {
  const w = new ListWidget();
  w.url = CONFIG.baseUrl;
  w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);

  const family = config.runsInWidget ? (config.widgetFamily || "medium") : CONFIG.preview;
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

  // header: title (not on small) on the left, status pills on the right
  const head = w.addStack();
  head.layoutHorizontally();
  head.centerAlignContent();
  head.size = new Size(innerW, pillH);
  if (!small) {
    const title = head.addText(CONFIG.name);
    title.font = Font.heavyRoundedSystemFont(13);
    title.textColor = THEME.text;
  }
  head.addSpacer();

  let s;
  try {
    s = await getStats();
  } catch (e) {
    addPill(head, "●", "OFFLINE", THEME.crit);
    w.addSpacer(8);
    const msg = w.addText("Can't reach NAS.\n" + String(e.message || e).slice(0, 80));
    msg.font = Font.systemFont(11);
    msg.textColor = THEME.dim;
    return w;
  }

  addPill(head, "●", fmtUptime(s.uptime) || "online", THEME.ok);
  if (s.docker) {
    head.addSpacer(5);
    addPill(head, "🐳", `${s.docker.running}/${s.docker.total}`, s.docker.running === s.docker.total ? THEME.ok : THEME.warn);
  } else if (small) {
    head.addSpacer(5);
    addPill(head, "↓", fmtRate(s.rx), null);
  }

  const tempPct = s.cpuTemp != null ? Math.min(100, (s.cpuTemp / CONFIG.tempCrit) * 100) : 0;
  const tiles = [
    ["CPU", `${Math.round(s.cpu)}%`, s.cpu, level(s.cpu), small ? null : (s.cores ? `${s.cores} cores` : " ")],
    ["RAM", `${Math.round(s.ram)}%`, s.ram, level(s.ram), small ? null : fmtPair(s.ramUsed, s.ramTotal)],
    ["DISK", `${Math.round(s.disk)}%`, s.disk, level(s.disk), small ? null : fmtPair(s.diskUsed, s.diskTotal)],
    s.cpuTemp != null
      ? ["TEMP", `${Math.round(s.cpuTemp)}°`, tempPct, tempLevel(s.cpuTemp), small ? null : "SoC"]
      : ["NET ↓", fmtRate(s.rx), 0, THEME.ok, small ? null : `↑ ${fmtRate(s.tx)}`],
  ];

  // ===== SMALL: 2x2 tiles =====
  if (small) {
    const gap = 5;
    const tw = Math.floor((innerW - gap) / 2);
    const th = Math.floor((innerH - pillH - gap - gap) / 2);
    w.addSpacer(gap);
    for (let r = 0; r < 2; r++) {
      const row = w.addStack();
      row.layoutHorizontally();
      addTile(row, tw, th, lvl, ...tiles[r * 2]);
      row.addSpacer(gap);
      addTile(row, tw, th, lvl, ...tiles[r * 2 + 1]);
      if (r === 0) w.addSpacer(gap);
    }
    return w;
  }

  // ===== MEDIUM: 4 tiles in a row, footer below =====
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
    // ===== LARGE: 2x2 tiles + temperature card, footer below =====
    const gap = 6;
    const tw = Math.floor((innerW - gap) / 2);
    const th = 78;
    const cardH = innerH - pillH - 8 - 2 * th - gap - gap - 6 - pillH;
    w.addSpacer(8);
    for (let r = 0; r < 2; r++) {
      const row = w.addStack();
      row.layoutHorizontally();
      addTile(row, tw, th, lvl, ...tiles[r * 2]);
      row.addSpacer(gap);
      addTile(row, tw, th, lvl, ...tiles[r * 2 + 1]);
      w.addSpacer(gap);
    }
    const temps = [...(s.temps || [])].sort((a, b) => b.value - a.value);
    addTempCard(w, innerW, Math.max(60, cardH), temps);
  }

  w.addSpacer();

  // footer: network on the left, drive temp on the right
  const foot = w.addStack();
  foot.layoutHorizontally();
  foot.centerAlignContent();
  foot.size = new Size(innerW, pillH);
  addPill(foot, "↓", fmtRate(s.rx), null);
  foot.addSpacer(5);
  addPill(foot, "↑", fmtRate(s.tx), null);
  foot.addSpacer();
  if (s.diskTemp != null) addPill(foot, "💾", `${Math.round(s.diskTemp)}°C`, tempLevel(s.diskTemp));
  return w;
}

const widget = await buildWidget();
if (config.runsInWidget) {
  Script.setWidget(widget);
} else if (CONFIG.preview === "small") {
  await widget.presentSmall();
} else if (CONFIG.preview === "large") {
  await widget.presentLarge();
} else {
  await widget.presentMedium();
}
Script.complete();
