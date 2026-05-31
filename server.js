/**
 * WLED Pixel Painter — Server
 *
 * Routes:
 *   GET  /              → public painter (index.html)
 *   GET  /admin         → admin panel (admin.html)  ← block this in your reverse proxy
 *
 * API:
 *   GET  /health
 *   GET  /api/config             → returns saved config (WLED IP is kept server-side)
 *   POST /api/config             → save config  [admin only — block at proxy]
 *   GET  /api/ping?wledIp=...    → test + auto-detect matrix/strip  [admin only]
 *   GET  /api/events             → SSE stream: canvas / delta / users events
 *   GET  /api/canvas             → full canvas snapshot (LED-indexed RGB)
 *   POST /api/send               → push pixels to WLED (pixels= full canvas | delta= changed pixels)
 *   POST /api/clear              → blank the strip
 */

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");
const dgram   = require("dgram");
const os      = require("os");

let Bonjour;
try { ({ Bonjour } = require("bonjour-service")); } catch { /* mDNS optional */ }

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Config persistence ────────────────────────────────────────────────────────
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, "config.json");

const DEFAULT_CONFIG = {
  wledIp:      "",
  brightness:  128,
  cols:        16,
  rows:        1,
  serpentine:  false,
  isMatrix:    false,
  deviceName:  "",
  ledCount:    16,
  udpPort:     21329,
  defaultMode: "desktop",
  scanSubnets: [],
};

// Returns /24 prefixes from real LAN interfaces (excludes loopback and Docker bridges).
function detectLocalSubnets() {
  const prefixes = new Set();
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      // Include 192.168.x.x and 10.x.x.x; skip Docker/VM bridge ranges (172.x).
      if (addr.address.startsWith("192.168.") || addr.address.startsWith("10.")) {
        const p = addr.address.split(".");
        prefixes.add(`${p[0]}.${p[1]}.${p[2]}`);
      }
    }
  }
  return [...prefixes];
}

// ── UDP realtime (DRGB protocol) ──────────────────────────────────────────────
// Reuse one socket for all sends to avoid per-frame socket creation overhead.
const udpSocket = dgram.createSocket("udp4");
udpSocket.on("error", (err) => console.warn("UDP socket error:", err.message));

function sendUdpPixels(ip, port, pixels, timeoutSecs = 30) {
  // WLED DRGB format: byte 0 = protocol (2), byte 1 = timeout in seconds,
  // then sequential R,G,B for each LED starting at index 0.
  const buf = Buffer.alloc(2 + pixels.length * 3);
  buf[0] = 2;
  buf[1] = timeoutSecs;
  pixels.forEach(([r, g, b], i) => {
    buf[2 + i * 3]     = r;
    buf[2 + i * 3 + 1] = g;
    buf[2 + i * 3 + 2] = b;
  });
  return new Promise((resolve, reject) =>
    udpSocket.send(buf, port, ip, (err) => (err ? reject(err) : resolve()))
  );
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
    }
  } catch (e) {
    console.warn("Could not read config, using defaults:", e.message);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(data) {
  const cfg = { ...loadConfig(), ...data };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

// ── Shared canvas state & SSE ─────────────────────────────────────────────────
// canvasState is LED-indexed [r,g,b] for each physical LED.
// It is the single source of truth sent to WLED; all painters merge into it.
let canvasState = [];
const sseClients = new Set();
let wledFlushTimer = null;

function initCanvas(ledCount) {
  canvasState = Array.from({ length: ledCount }, () => [0, 0, 0]);
}
initCanvas(loadConfig().ledCount || 256);

function broadcastSse(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

// Debounced WLED flush: caps output at ~30 fps regardless of painter count.
// timeoutSecs=255 is the DRGB protocol max (~4 min hold per packet).
function scheduleWledFlush() {
  if (wledFlushTimer) return;
  wledFlushTimer = setTimeout(async () => {
    wledFlushTimer = null;
    const cfg = loadConfig();
    if (!cfg.wledIp || canvasState.length === 0) return;
    await sendUdpPixels(cfg.wledIp, cfg.udpPort || 21329, canvasState, 255).catch(() => {});
  }, 33);
}

// Keepalive: re-send the canvas every 60 s so WLED never times out while
// the server is running and the canvas has any painted pixels.
setInterval(async () => {
  const cfg = loadConfig();
  if (!cfg.wledIp || canvasState.length === 0) return;
  if (canvasState.every(([r, g, b]) => r === 0 && g === 0 && b === 0)) return;
  await sendUdpPixels(cfg.wledIp, cfg.udpPort || 21329, canvasState, 255).catch(() => {});
}, 60_000);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Page routes ───────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  const cfg  = loadConfig();
  const file = cfg.defaultMode === "tablet" ? "tablet.html" : "index.html";
  res.sendFile(path.join(__dirname, "public", file));
});

app.get(["/desktop", "/desktop/"], (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get(["/tablet", "/tablet/"], (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "tablet.html"));
});

app.get(["/admin", "/admin/"], (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ── SSE: real-time canvas sync ────────────────────────────────────────────────
app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection":    "keep-alive",
    "X-Accel-Buffering": "no",   // prevent nginx from buffering SSE
  });

  // Bootstrap this client with the full current canvas and user count.
  res.write(`event: canvas\ndata: ${JSON.stringify(canvasState)}\n\n`);
  sseClients.add(res);
  res.write(`event: users\ndata: ${JSON.stringify(sseClients.size)}\n\n`);
  broadcastSse("users", sseClients.size);

  // Keep-alive ping every 25 s to prevent proxies from closing idle connections.
  const heartbeat = setInterval(() => {
    try { res.write(": keep-alive\n\n"); }
    catch { sseClients.delete(res); clearInterval(heartbeat); }
  }, 25000);

  req.on("close", () => {
    sseClients.delete(res);
    clearInterval(heartbeat);
    broadcastSse("users", sseClients.size);
  });
});

// Full canvas snapshot (useful if a client missed SSE bootstrap or prefers polling).
app.get("/api/canvas", (_req, res) => {
  res.json({ ok: true, canvas: canvasState, users: sseClients.size });
});

// ── Config API ────────────────────────────────────────────────────────────────

// Public: returns config minus the WLED IP.
// If no scanSubnets saved yet, auto-detect from local network interfaces.
app.get("/api/config", (_req, res) => {
  const { wledIp, ...safe } = loadConfig();
  if (!safe.scanSubnets?.length) safe.scanSubnets = detectLocalSubnets();
  res.json({ ok: true, config: safe });
});

// Admin only — block POST /api/config at your reverse proxy
app.post("/api/config", (req, res) => {
  try {
    const cfg = saveConfig(req.body);
    const { wledIp, ...safe } = cfg;
    res.json({ ok: true, config: safe });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Ping + auto-detect ────────────────────────────────────────────────────────
app.get("/api/ping", async (req, res) => {
  const wledIp = req.query.wledIp || loadConfig().wledIp;

  if (!wledIp) {
    return res.status(400).json({ ok: false, error: "wledIp required" });
  }

  try {
    const response = await fetch(`http://${wledIp}/json/info`, {
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      return res.status(502).json({ ok: false, error: `WLED returned ${response.status}` });
    }

    const info = await response.json();

    // Auto-detect 2D matrix vs 1D strip
    // WLED sets info.leds.matrix = { w, h } when a 2D matrix is configured
    const matrix   = info?.leds?.matrix;
    const isMatrix = !!(matrix?.w && matrix?.h && matrix.h > 1);
    const cols     = isMatrix ? matrix.w  : (info?.leds?.count ?? 30);
    const rows     = isMatrix ? matrix.h  : 1;
    const ledCount = info?.leds?.count ?? cols * rows;

    saveConfig({ wledIp, isMatrix, cols, rows, ledCount, deviceName: info?.name ?? "", udpPort: info?.udpport ?? 21329 });
    if (ledCount !== canvasState.length) initCanvas(ledCount);

    return res.json({
      ok: true,
      info,
      detected: { isMatrix, cols, rows, ledCount },
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: `Could not reach WLED at ${wledIp}: ${err.message}`,
    });
  }
});

// ── Device discovery ──────────────────────────────────────────────────────────
// Streams SSE events: scanning → device (per found device) → done
// mDNS (local subnet, instant) runs in parallel with HTTP subnet scan.
app.get("/api/discover", async (req, res) => {
  res.writeHead(200, {
    "Content-Type":      "text/event-stream",
    "Cache-Control":     "no-cache",
    "Connection":        "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const found  = new Set();
  let   closed = false;
  req.on("close", () => { closed = true; });

  function emit(event, data) {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function parseDevice(ip, info) {
    const matrix   = info?.leds?.matrix;
    const isMatrix = !!(matrix?.w && matrix?.h && matrix.h > 1);
    const cols     = isMatrix ? matrix.w : (info?.leds?.count ?? 1);
    const rows     = isMatrix ? matrix.h : 1;
    const ledCount = info?.leds?.count ?? cols * rows;
    return { ip, name: info?.name ?? ip, isMatrix, cols, rows, ledCount, ver: info?.ver ?? null };
  }

  function offerDevice(ip, info) {
    if (found.has(ip) || closed) return;
    found.add(ip);
    emit("device", parseDevice(ip, info));
  }

  // ── mDNS (bonjour) ────────────────────────────────────────────────────────
  let mdnsDone = false;
  const MDNS_TIMEOUT = 4000;

  if (Bonjour) {
    let bonjour, browser;
    try {
      bonjour = new Bonjour();
      browser = bonjour.find({ type: "wled" }, async (service) => {
        const ip = service.addresses?.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a))
                   ?? service.referer?.address;
        if (!ip || closed) return;
        try {
          const r = await fetch(`http://${ip}/json/info`, { signal: AbortSignal.timeout(2000) });
          const info = await r.json();
          if (info?.leds) offerDevice(ip, info);
        } catch {}
      });
    } catch (e) {
      console.warn("mDNS init failed:", e.message);
    }

    setTimeout(() => {
      try { browser?.stop(); bonjour?.destroy(); } catch {}
      mdnsDone = true;
    }, MDNS_TIMEOUT);
  } else {
    mdnsDone = true;
  }

  // ── Subnet scan ───────────────────────────────────────────────────────────
  const cfg     = loadConfig();
  const subnets = cfg.scanSubnets?.length ? cfg.scanSubnets : detectLocalSubnets();
  const ips     = subnets.flatMap(prefix =>
    Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`)
  );

  emit("scanning", { total: ips.length, subnets });

  await Promise.allSettled(ips.map(async ip => {
    if (closed) return;
    try {
      const r = await fetch(`http://${ip}/json/info`, { signal: AbortSignal.timeout(500) });
      if (!r.ok) return;
      const info = await r.json();
      if (info?.leds) offerDevice(ip, info);
    } catch {}
  }));

  // Wait for mDNS window to close before ending the stream.
  if (!mdnsDone) await new Promise(r => setTimeout(r, MDNS_TIMEOUT));
  emit("done", { count: found.size });
  res.end();
});

// ── Send pixels ───────────────────────────────────────────────────────────────
// Accepts two shapes:
//   { pixels: [[r,g,b], …], brightness }  — full canvas, LED-indexed (single-player)
//   { delta:  [[ledIdx,r,g,b], …], brightness } — changed pixels only (multiplayer)
// In both cases the server merges into canvasState, broadcasts to SSE peers,
// and schedules a debounced WLED flush (~30 fps cap).
app.post("/api/send", (req, res) => {
  const cfg = loadConfig();
  const { pixels, delta, brightness } = req.body;

  if (!cfg.wledIp) {
    return res.status(400).json({ ok: false, error: "No WLED IP configured. Visit /admin." });
  }

  // Ensure canvas is sized correctly (e.g. after a fresh config load).
  if (canvasState.length === 0) initCanvas(cfg.ledCount || cfg.cols * cfg.rows || 16);

  const bri = brightness ?? cfg.brightness ?? 128;
  let changes; // [[ledIdx, r, g, b], …] — what to broadcast and merge

  if (Array.isArray(delta) && delta.length > 0) {
    // Multiplayer delta: merge only the changed LEDs.
    changes = delta;
    for (const [ledIdx, r, g, b] of delta) {
      if (ledIdx >= 0 && ledIdx < canvasState.length) canvasState[ledIdx] = [r, g, b];
    }
  } else if (Array.isArray(pixels) && pixels.length > 0) {
    // Single-player full canvas: replace everything.
    changes = pixels.map((rgb, i) => [i, ...(rgb ?? [0, 0, 0])]);
    pixels.forEach((rgb, i) => { if (i < canvasState.length && rgb) canvasState[i] = rgb; });
  } else {
    return res.status(400).json({ ok: false, error: "pixels or delta required" });
  }

  // Broadcast to all other connected painters.
  if (sseClients.size > 0) broadcastSse("delta", changes);

  // Non-blocking brightness update only when it changes.
  if (bri !== cfg.brightness) {
    saveConfig({ brightness: bri });
    fetch(`http://${cfg.wledIp}/json/state`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on: true, bri }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  }

  scheduleWledFlush();
  return res.json({ ok: true });
});

// ── Clear strip ───────────────────────────────────────────────────────────────
app.post("/api/clear", async (req, res) => {
  const cfg   = loadConfig();
  const count = cfg.ledCount || cfg.cols * cfg.rows || 30;

  if (!cfg.wledIp) {
    return res.status(400).json({ ok: false, error: "No WLED IP configured. Visit /admin." });
  }

  // Reset shared canvas and tell all painters to blank their grids.
  initCanvas(count);
  if (sseClients.size > 0) broadcastSse("canvas", canvasState);

  try {
    const blank = Array.from({ length: count }, () => [0, 0, 0]);
    await sendUdpPixels(cfg.wledIp, cfg.udpPort || 21329, blank, 1);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(502).json({ ok: false, error: `Clear failed: ${err.message}` });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🌈 WLED Pixel Painter`);
  console.log(`   Public UI:  http://localhost:${PORT}/`);
  console.log(`   Admin:      http://localhost:${PORT}/admin`);
  console.log(`   Config:     ${CONFIG_PATH}\n`);
});
