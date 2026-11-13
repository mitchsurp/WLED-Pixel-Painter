/**
 * WLED Pixel Painter — Server
 *
 * Routes:
 *   GET  /                       → default painter (PIN gate & unified responsive matrix painter)
 *   GET  /house                  → real-space house & yard painter (house.html)
 *   GET  /desktop or /matrix     → unified 2D matrix painter (index.html)
 *   GET  /tablet                 → unified responsive matrix painter (index.html)
 *   GET  /strip                  → 1D LED strip painter
 *   GET  /admin                  → admin panel (admin.html) [block at reverse proxy]
 *
 * Public API:
 *   GET  /health
 *   GET  /api/config             → safe config (house layout, mode, safe instances)
 *   GET  /api/events             → SSE stream: bootstrap / delta / canvas / users events
 *   GET  /api/canvas             → full canvas snapshots
 *   POST /api/send               → push pixels (elementDeltas | deltas | delta | pixels)
 *   POST /api/clear              → blank strip(s) and return WLED to default effects
 *
 * Admin API [block at reverse proxy]:
 *   GET  /api/admin/config       → full config with IPs and controller details
 *   POST /api/admin/config       → save config
 *   POST /api/config             → save config (alias for backwards compatibility)
 *   GET  /api/ping?ip=...        → inspect WLED device & segments
 *   GET  /api/discover           → SSE stream: discover WLED devices via mDNS + subnet scan
 *   POST /api/admin/test-element → test/flash a specific string on physical LEDs
 */

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");
const dgram   = require("dgram");
const os      = require("os");
const crypto  = require("crypto");

let Bonjour;
try { ({ Bonjour } = require("bonjour-service")); } catch { /* mDNS optional */ }

let WebSocket;
try { WebSocket = require("ws"); } catch { WebSocket = globalThis.WebSocket; }

const app  = express();
const PORT = process.env.PORT || 3001;

// ── File & Static Helpers ──────────────────────────────────────────────────────
const CONFIG_PATH  = process.env.CONFIG_PATH  || path.join(__dirname, "config.json");
const GALLERY_PATH = process.env.GALLERY_PATH || path.join(path.dirname(CONFIG_PATH), "gallery.json");

function resolveHtmlFile(filename) {
  const publicPath = path.join(__dirname, "public", filename);
  if (fs.existsSync(publicPath)) return publicPath;
  return path.join(__dirname, filename);
}

// ── Default House Layout Generator ─────────────────────────────────────────────
function getDefaultHouseConfig(instances = []) {
  const primaryId = instances[0]?.id || "inst_1";
  return {
    stories: 2,               // 1, 2, or 3 stories
    style: "craftsman",
    wallColor: "#1d2333",
    roofColor: "#121520",
    trimColor: "#475175",
    doorColor: "#932b44",
    windowLitColor: "#fff4d4",
    yardEnabled: true,
    elements: [
      {
        id: "roof_main",
        name: "Main Roof Peak",
        type: "line",
        category: "house",
        points: [
          { x: 150, y: 250 },
          { x: 500, y: 80 },
          { x: 850, y: 250 }
        ],
        instanceId: primaryId,
        segmentId: 0,
        startLed: 0,
        ledCount: 80,
        reverse: false
      },
      {
        id: "roof_fascia",
        name: "Roof Eaves / Fascia",
        type: "line",
        category: "house",
        points: [
          { x: 150, y: 250 },
          { x: 850, y: 250 }
        ],
        instanceId: primaryId,
        segmentId: 0,
        startLed: 80,
        ledCount: 40,
        reverse: false
      },
      {
        id: "win_2_left",
        name: "2nd Story Left Window",
        type: "window",
        category: "house",
        story: 2,
        x: 250,
        y: 280,
        w: 90,
        h: 100,
        startCorner: "bottom-left",
        direction: "clockwise",
        instanceId: primaryId,
        segmentId: 0,
        startLed: 120,
        ledCount: 28,
        reverse: false
      },
      {
        id: "win_2_right",
        name: "2nd Story Right Window",
        type: "window",
        category: "house",
        story: 2,
        x: 660,
        y: 280,
        w: 90,
        h: 100,
        startCorner: "bottom-left",
        direction: "clockwise",
        instanceId: primaryId,
        segmentId: 0,
        startLed: 148,
        ledCount: 28,
        reverse: false
      },
      {
        id: "win_1_left",
        name: "1st Story Left Window",
        type: "window",
        category: "house",
        story: 1,
        x: 230,
        y: 440,
        w: 110,
        h: 100,
        startCorner: "bottom-left",
        direction: "clockwise",
        instanceId: primaryId,
        segmentId: 0,
        startLed: 176,
        ledCount: 32,
        reverse: false
      },
      {
        id: "win_1_right",
        name: "1st Story Right Window",
        type: "window",
        category: "house",
        story: 1,
        x: 660,
        y: 440,
        w: 110,
        h: 100,
        startCorner: "bottom-left",
        direction: "clockwise",
        instanceId: primaryId,
        segmentId: 0,
        startLed: 208,
        ledCount: 32,
        reverse: false
      },
      {
        id: "yard_walkway",
        name: "Front Walkway",
        type: "line",
        category: "yard",
        points: [
          { x: 440, y: 570 },
          { x: 470, y: 630 },
          { x: 500, y: 700 }
        ],
        instanceId: primaryId,
        segmentId: 0,
        startLed: 240,
        ledCount: 16,
        reverse: false
      }
    ]
  };
}

const DEFAULT_CONFIG = {
  defaultMode:           "matrix", // "matrix", "desktop", "tablet", "house", "strip"
  brightness:            128,
  keepaliveSecs:         60,
  udpPort:               21329,
  scanSubnets:           [],
  instances:             [],
  house:                 null,
  allowViewSwitching:    false,    // Isolated view mode (no navigating away)
  brushRadius:           10,       // Granular brush precision
  singlePixelTap:        true,     // Single tap colors exactly 1 LED
  releaseLiveOnClear:    true,     // Automatically release live UDP override on clear
  slideshowEnabled:      false,    // Ambient Art Frame Slideshow
  slideshowIntervalSecs: 45,       // Seconds per piece in slideshow
  slideshowIdleMinutes:  3,        // Start slideshow after X minutes of inactivity
  // Legacy single-device fallbacks
  wledIp:                "",
  cols:                  16,
  rows:                  16,
  serpentine:            false,
  isMatrix:              true,
  deviceName:            "Matrix 1",
  ledCount:              256,
};

// ── LAN Subnet Detection ───────────────────────────────────────────────────────
function detectLocalSubnets() {
  const prefixes = new Set();
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (addr.address.startsWith("192.168.") || addr.address.startsWith("10.")) {
        const p = addr.address.split(".");
        prefixes.add(`${p[0]}.${p[1]}.${p[2]}`);
      }
    }
  }
  return [...prefixes];
}

// ── Config Normalization & Persistence ─────────────────────────────────────────
function normalizeConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG, ...raw };

  // Migrate legacy single-device configuration or initialize default instance
  if (!Array.isArray(cfg.instances) || cfg.instances.length === 0) {
    cfg.instances = [
      {
        id:         "inst_1",
        name:       cfg.deviceName || "Matrix 1",
        ip:         cfg.wledIp || "",
        udpPort:    cfg.udpPort || 21329,
        ledCount:   cfg.ledCount || (cfg.cols * cfg.rows) || 256,
        isMatrix:   cfg.isMatrix !== undefined ? !!cfg.isMatrix : true,
        cols:       cfg.cols || 16,
        rows:       cfg.rows || 16,
        serpentine: !!cfg.serpentine,
        pin:        "1001",
        segments:   []
      }
    ];
  } else {
    // Ensure all instances have complete fields including unique PINs
    let nextPinNum = 1001;
    const usedPins = new Set();

    cfg.instances = cfg.instances.map((inst, idx) => {
      const isMatrix = inst.isMatrix !== undefined ? !!inst.isMatrix : ((inst.rows || 1) > 1);
      const cols = parseInt(inst.cols, 10) || (isMatrix ? 16 : 16);
      const rows = parseInt(inst.rows, 10) || (isMatrix ? 16 : 1);
      const ledCount = parseInt(inst.ledCount, 10) || (cols * rows) || 256;

      let pin = (typeof inst.pin === "string" && inst.pin.trim()) ? inst.pin.trim() : "";
      if (!pin) {
        while (usedPins.has(String(nextPinNum))) {
          nextPinNum++;
        }
        pin = String(nextPinNum++);
      }
      usedPins.add(pin);

      return {
        id:         inst.id || `inst_${idx + 1}`,
        name:       inst.name || `WLED Matrix ${idx + 1}`,
        ip:         inst.ip || "",
        udpPort:    parseInt(inst.udpPort, 10) || 21329,
        ledCount:   ledCount,
        isMatrix:   isMatrix,
        cols:       cols,
        rows:       rows,
        serpentine: !!inst.serpentine,
        pin:        pin,
        segments:   Array.isArray(inst.segments) ? inst.segments : []
      };
    });
  }

  // Keep legacy fields synchronized with the first instance for backward compatibility
  const primary = cfg.instances[0];
  if (primary) {
    cfg.wledIp     = primary.ip;
    cfg.deviceName = primary.name;
    cfg.ledCount   = primary.ledCount;
    cfg.udpPort    = primary.udpPort;
    cfg.isMatrix   = primary.isMatrix;
    cfg.cols       = primary.cols;
    cfg.rows       = primary.rows;
    cfg.serpentine = primary.serpentine;
  }

  // Initialize house layout if missing
  if (!cfg.house || !Array.isArray(cfg.house.elements)) {
    cfg.house = getDefaultHouseConfig(cfg.instances);
  } else {
    // Ensure house structure fields
    cfg.house.stories     = cfg.house.stories || 2;
    cfg.house.style       = cfg.house.style || "craftsman";
    cfg.house.wallColor   = cfg.house.wallColor || "#1d2333";
    cfg.house.roofColor   = cfg.house.roofColor || "#121520";
    cfg.house.trimColor   = cfg.house.trimColor || "#475175";
    cfg.house.doorColor   = cfg.house.doorColor || "#932b44";
    cfg.house.yardEnabled = cfg.house.yardEnabled !== false;
    cfg.house.elements    = cfg.house.elements.map((el, i) => ({
      id:          el.id || `el_${i + 1}`,
      name:        el.name || `Light String ${i + 1}`,
      type:        el.type || (el.story ? "window" : "line"),
      category:    el.category || (el.type === "window" ? "house" : (el.points?.[0]?.y > 550 ? "yard" : "house")),
      story:       el.story || (el.type === "window" ? 1 : undefined),
      x:           el.x ?? 200,
      y:           el.y ?? 200,
      w:           el.w ?? 100,
      h:           el.h ?? 100,
      points:      Array.isArray(el.points) ? el.points : [],
      instanceId:  el.instanceId || primary?.id || "inst_1",
      segmentId:   el.segmentId ?? 0,
      startLed:    el.startLed ?? 0,
      ledCount:    el.ledCount ?? 30,
      reverse:     !!el.reverse,
      startCorner: el.startCorner || "bottom-left",
      direction:   el.direction || "clockwise"
    }));
  }

  cfg.allowViewSwitching    = !!cfg.allowViewSwitching;
  cfg.brushRadius           = typeof cfg.brushRadius === "number" ? cfg.brushRadius : 10;
  cfg.singlePixelTap        = cfg.singlePixelTap !== false;
  cfg.releaseLiveOnClear    = cfg.releaseLiveOnClear !== false;
  cfg.slideshowEnabled      = !!cfg.slideshowEnabled;
  cfg.slideshowIntervalSecs = parseInt(cfg.slideshowIntervalSecs, 10) || 45;
  cfg.slideshowIdleMinutes  = parseInt(cfg.slideshowIdleMinutes, 10) || 3;

  if (!cfg.scanSubnets?.length) {
    cfg.scanSubnets = detectLocalSubnets();
  }

  return cfg;
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      return normalizeConfig(parsed);
    }
  } catch (e) {
    console.warn("Could not read config, using defaults:", e.message);
  }
  return normalizeConfig({});
}

function saveConfig(data) {
  const current = loadConfig();
  const merged = normalizeConfig({ ...current, ...data });
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  } catch (err) {
    console.error("Failed to write config file:", err.message);
  }
  // Sync in-memory canvas state with updated instances
  syncCanvasInstances(merged.instances);
  return merged;
}

// ── Persistent Creation Gallery ────────────────────────────────────────────────
function getSeedGalleryArt() {
  const palette = {
    " ": [0, 0, 0],
    "W": [255, 255, 255],
    "w": [215, 240, 255],
    "C": [0, 240, 255],
    "c": [0, 180, 230],
    "B": [0, 110, 255],
    "b": [0, 60, 180],
    "V": [145, 0, 255],
    "v": [90, 0, 170],
    "M": [255, 0, 140],
    "m": [180, 0, 95],
    "Y": [255, 225, 50],
    "A": [255, 140, 0],
  };

  const art1 = [
    "       B C      ",
    "  A    c C      ",
    " A Y A c C   m  ",
    "  A   bC Cb m M ",
    " c   b CwwC b m ",
    "    v CwWWwC v  ",
    "   v CwWWWWwC v ",
    "bCcCwwWWWWWWwwCc",
    "bCcCwwWWWWWWwwCc",
    "   v CwWWWWwC v ",
    "    v CwWWwC v c",
    " m   b CwwC b   ",
    "M m   bC Cb   A ",
    " m     c C  A YA",
    "       c C    A ",
    "       C B      ",
  ];

  const px1 = [];
  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 16; c++) {
      px1.push(palette[art1[r][c] || " "] || [0, 0, 0]);
    }
  }

  const art2 = [
    "                ",
    "  MMMM    MMMM  ",
    " MMMMMM  MMMMMM ",
    " MMMWWMMMMWWMMM ",
    " MMMWWMMMMWWMMM ",
    " MMMMMMMMMMMMMM ",
    "  MMMMMMMMMMMM  ",
    "  vvMMMMMMMMvv  ",
    "   vvMMMMMMvv   ",
    "    vvMMMMvv    ",
    "     vvMMvv     ",
    "      vvvv      ",
    "       vv       ",
    "                ",
    "   CC      CC   ",
    "                ",
  ];
  const px2 = [];
  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 16; c++) {
      px2.push(palette[art2[r][c] || " "] || [0, 0, 0]);
    }
  }

  return [
    {
      id: "art_seed_1",
      title: "The Quantum Spark",
      author: "Antigravity",
      createdAt: new Date().toISOString(),
      matrixId: "inst_1",
      cols: 16,
      rows: 16,
      pixels: px1
    },
    {
      id: "art_seed_2",
      title: "Cyber Heart",
      author: "Studio",
      createdAt: new Date().toISOString(),
      matrixId: "inst_1",
      cols: 16,
      rows: 16,
      pixels: px2
    }
  ];
}

function loadGallery() {
  try {
    if (fs.existsSync(GALLERY_PATH)) {
      const data = JSON.parse(fs.readFileSync(GALLERY_PATH, "utf8"));
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch (e) {
    console.warn("Could not read gallery.json, seeding defaults:", e.message);
  }
  const seeds = getSeedGalleryArt();
  saveGallery(seeds);
  return seeds;
}

function saveGallery(items) {
  try {
    fs.mkdirSync(path.dirname(GALLERY_PATH), { recursive: true });
    fs.writeFileSync(GALLERY_PATH, JSON.stringify(items, null, 2));
  } catch (err) {
    console.error("Failed to write gallery file:", err.message);
  }
}

// ── Multi-Instance Canvas State ────────────────────────────────────────────────
// instanceCanvases: Map<instanceId, Array<[r, g, b]>>
const instanceCanvases = new Map();
const sseClients       = new Set();
let wledFlushTimer     = null;
const dirtyInstances   = new Set();

function syncCanvasInstances(instances) {
  const currentIds = new Set(instances.map(inst => inst.id));

  // Remove stale instances
  for (const id of instanceCanvases.keys()) {
    if (!currentIds.has(id)) instanceCanvases.delete(id);
  }

  // Add or resize existing instances
  for (const inst of instances) {
    const count = inst.ledCount || 256;
    const existing = instanceCanvases.get(inst.id);
    if (!existing || existing.length !== count) {
      const newCanvas = Array.from({ length: count }, (_, i) => existing?.[i] || [0, 0, 0]);
      instanceCanvases.set(inst.id, newCanvas);
    }
  }
}

// Bootstrap canvases on startup
const initialCfg = loadConfig();
syncCanvasInstances(initialCfg.instances);
const livePausedInstances = new Set(); // instances where live mode is paused / presets active

// ── Multi-Matrix Sessions & Mapping ──────────────────────────────────────────
// matrixSessions: Map<token, { instanceId: string, createdAt: number }>
const matrixSessions = new Map();

function findMatrixByPin(pin) {
  if (!pin && pin !== 0) return null;
  const cleanPin = String(pin).trim();
  if (!cleanPin) return null;
  const cfg = loadConfig();
  return cfg.instances.find(inst => String(inst.pin || "").trim() === cleanPin);
}

function getMatrixSession(req) {
  let token = null;
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  }
  if (!token) {
    token = req.headers?.["x-session-token"] || req.headers?.["x-matrix-token"] || req.query?.token;
  }
  if (!token || !matrixSessions.has(token)) return null;

  const session = matrixSessions.get(token);
  const cfg = loadConfig();
  const inst = cfg.instances.find(i => i.id === session.instanceId);
  if (!inst) return null;
  return { token, instance: inst, instanceId: inst.id };
}

function getPhysicalLedIndex(inst, col, row) {
  const cols = inst.cols || 16;
  const rows = inst.rows || 16;
  if (col < 0 || col >= cols || row < 0 || row >= rows) return -1;
  let idx;
  if (inst.serpentine && row % 2 === 1) {
    idx = row * cols + (cols - 1 - col);
  } else {
    idx = row * cols + col;
  }
  return idx;
}

// ── UDP Realtime DRGB & DNRGB Engine ───────────────────────────────────────────
const udpSocket = dgram.createSocket("udp4");
udpSocket.on("error", (err) => console.warn("UDP socket error:", err.message));

function sendUdpBuffer(buf, port, ip) {
  return new Promise((resolve, reject) => {
    udpSocket.send(buf, port, ip, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Sends pixels to a WLED instance over UDP.
 * Uses WLED DRGB (protocol 2) for <= 490 LEDs.
 * Automatically chunks using WLED DNRGB (protocol 4) for > 490 LEDs.
 */
async function sendToInstance(inst, timeoutSecs = 255) {
  if (!inst || !inst.ip) return;
  const canvas = instanceCanvases.get(inst.id);
  if (!canvas || canvas.length === 0) return;

  const count = inst.ledCount || canvas.length;
  const port  = inst.udpPort || 21329;

  if (count <= 490) {
    // Protocol 2: DRGB [proto=2, timeout, R, G, B, ...]
    const buf = Buffer.alloc(2 + count * 3);
    buf[0] = 2;
    buf[1] = Math.min(255, Math.max(1, timeoutSecs));
    for (let i = 0; i < count; i++) {
      const [r, g, b] = canvas[i] || [0, 0, 0];
      buf[2 + i * 3]     = r;
      buf[2 + i * 3 + 1] = g;
      buf[2 + i * 3 + 2] = b;
    }
    return sendUdpBuffer(buf, port, inst.ip);
  } else {
    // Protocol 4: DNRGB [proto=4, timeout, startHigh, startLow, R, G, B, ...]
    const CHUNK_SIZE = 450;
    const promises = [];
    for (let offset = 0; offset < count; offset += CHUNK_SIZE) {
      const chunkLen = Math.min(CHUNK_SIZE, count - offset);
      const buf = Buffer.alloc(4 + chunkLen * 3);
      buf[0] = 4;
      buf[1] = Math.min(255, Math.max(1, timeoutSecs));
      buf[2] = (offset >> 8) & 0xFF;
      buf[3] = offset & 0xFF;
      for (let i = 0; i < chunkLen; i++) {
        const [r, g, b] = canvas[offset + i] || [0, 0, 0];
        buf[4 + i * 3]     = r;
        buf[4 + i * 3 + 1] = g;
        buf[4 + i * 3 + 2] = b;
      }
      promises.push(sendUdpBuffer(buf, port, inst.ip));
    }
    return Promise.all(promises);
  }
}

// Debounced flush: flushes dirty WLED instances every ~33ms (~30 fps max)
function scheduleWledFlush(instanceId) {
  if (instanceId) dirtyInstances.add(instanceId);
  if (wledFlushTimer) return;

  wledFlushTimer = setTimeout(async () => {
    wledFlushTimer = null;
    const cfg = loadConfig();
    const instMap = new Map(cfg.instances.map(inst => [inst.id, inst]));

    const idsToSend = dirtyInstances.size > 0
      ? Array.from(dirtyInstances)
      : cfg.instances.map(i => i.id);
    dirtyInstances.clear();

    for (const id of idsToSend) {
      const inst = instMap.get(id);
      if (inst && inst.ip) {
        const timeout = Math.min(255, Math.max(10, (cfg.keepaliveSecs || 30) * 2));
        await sendToInstance(inst, timeout).catch(() => {});
      }
    }
  }, 33);
}

// Keepalive: periodically re-sends painted canvases to active WLED devices
let lastKeepaliveSend = Date.now();
setInterval(async () => {
  const cfg = loadConfig();
  const intervalSecs = cfg.keepaliveSecs ?? 60;
  if (intervalSecs <= 0) return; // Keepalive disabled
  if (Date.now() - lastKeepaliveSend < intervalSecs * 1000) return;
  lastKeepaliveSend = Date.now();

  for (const inst of cfg.instances) {
    if (!inst.ip) continue;
    if (livePausedInstances.has(inst.id)) continue; // Skip if live released or preset active
    const canvas = instanceCanvases.get(inst.id);
    if (!canvas || canvas.length === 0) continue;
    // Only re-send if canvas has painted LEDs (non-black)
    if (canvas.some(([r, g, b]) => r > 0 || g > 0 || b > 0)) {
      const timeout = Math.min(255, Math.max(10, intervalSecs * 2));
      await sendToInstance(inst, timeout).catch(() => {});
    }
  }
}, 5000);

// ── SSE Broadcast Helpers ──────────────────────────────────────────────────────
function broadcastSse(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.use(express.static(__dirname, { index: false }));

// ── Page Routes ───────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.sendFile(resolveHtmlFile("index.html"));
});

app.get(["/house", "/house/"], (_req, res) => {
  res.sendFile(resolveHtmlFile("house.html"));
});

app.get(["/desktop", "/desktop/", "/matrix", "/matrix/", "/tablet", "/tablet/"], (_req, res) => {
  res.sendFile(resolveHtmlFile("index.html"));
});

app.get(["/strip", "/strip/"], (_req, res) => {
  // Strip view: uses house.html or index.html configured for strip
  res.sendFile(resolveHtmlFile("house.html"));
});

app.get(["/admin", "/admin/"], (_req, res) => {
  res.sendFile(resolveHtmlFile("admin.html"));
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ── SSE: Real-time Sync ───────────────────────────────────────────────────────
app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type":      "text/event-stream",
    "Cache-Control":     "no-cache",
    "Connection":        "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const cfg = loadConfig();
  const devicesObj = {};
  for (const [id, canvas] of instanceCanvases.entries()) {
    devicesObj[id] = canvas;
  }

  // Bootstrap with multi-device state
  res.write(`event: bootstrap\ndata: ${JSON.stringify({
    devices: devicesObj,
    house: cfg.house,
    users: sseClients.size + 1
  })}\n\n`);

  // Legacy canvas event for single-device clients
  const primaryId = cfg.instances[0]?.id;
  const primaryCanvas = primaryId ? (instanceCanvases.get(primaryId) || []) : [];
  res.write(`event: canvas\ndata: ${JSON.stringify(primaryCanvas)}\n\n`);

  sseClients.add(res);
  broadcastSse("users", sseClients.size);

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

// ── Canvas Snapshot API ───────────────────────────────────────────────────────
app.get("/api/canvas", (_req, res) => {
  const cfg = loadConfig();
  const devicesObj = {};
  for (const [id, canvas] of instanceCanvases.entries()) {
    devicesObj[id] = canvas;
  }
  const primaryId = cfg.instances[0]?.id;
  const legacyCanvas = primaryId ? (instanceCanvases.get(primaryId) || []) : [];

  res.json({
    ok: true,
    devices: devicesObj,
    canvas: legacyCanvas,
    users: sseClients.size
  });
});

// ── Config APIs ───────────────────────────────────────────────────────────────

// Public config: hides private IPs when reverse proxy exposes this publicly
app.get("/api/config", (_req, res) => {
  const cfg = loadConfig();
  const safeInstances = cfg.instances.map(inst => ({
    id:         inst.id,
    name:       inst.name,
    ledCount:   inst.ledCount,
    isMatrix:   inst.isMatrix,
    cols:       inst.cols,
    rows:       inst.rows,
    serpentine: inst.serpentine
  }));

  res.json({
    ok: true,
    config: {
      defaultMode:           cfg.defaultMode,
      brightness:            cfg.brightness,
      keepaliveSecs:         cfg.keepaliveSecs,
      instances:             safeInstances,
      house:                 cfg.house,
      allowViewSwitching:    cfg.allowViewSwitching,
      brushRadius:           cfg.brushRadius,
      singlePixelTap:        cfg.singlePixelTap,
      releaseLiveOnClear:    cfg.releaseLiveOnClear,
      slideshowEnabled:      cfg.slideshowEnabled,
      slideshowIntervalSecs: cfg.slideshowIntervalSecs,
      slideshowIdleMinutes:  cfg.slideshowIdleMinutes,
      // legacy support
      deviceName:    cfg.deviceName,
      ledCount:      cfg.ledCount,
      isMatrix:      cfg.isMatrix,
      cols:          cfg.cols,
      rows:          cfg.rows,
      serpentine:    cfg.serpentine,
      udpPort:       cfg.udpPort
    }
  });
});

// Admin full config: includes IPs, discovery subnets, and full device settings
app.get("/api/admin/config", (_req, res) => {
  const cfg = loadConfig();
  res.json({ ok: true, config: cfg });
});

// Save config endpoint (accessible via /api/admin/config or legacy /api/config)
function handleSaveConfig(req, res) {
  try {
    const saved = saveConfig(req.body);
    broadcastSse("config_updated", { house: saved.house, defaultMode: saved.defaultMode });
    res.json({ ok: true, config: saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

app.post("/api/admin/config", handleSaveConfig);
app.post("/api/config", handleSaveConfig);

// ── Admin: Quick Set Instance PIN ─────────────────────────────────────────────
app.post("/api/admin/instance/pin", (req, res) => {
  const { instanceId, pin } = req.body || {};
  if (!instanceId || !pin) {
    return res.status(400).json({ ok: false, error: "instanceId and pin are required" });
  }
  const cfg = loadConfig();
  const inst = cfg.instances.find(i => i.id === instanceId);
  if (!inst) {
    return res.status(404).json({ ok: false, error: "Instance not found" });
  }
  inst.pin = String(pin).trim();
  saveConfig(cfg);
  return res.json({ ok: true, instanceId, pin: inst.pin });
});

// ── Matrix User APIs (PIN-Protected, Zero URL Leaks) ──────────────────────────

// Verify PIN and create Matrix session
app.post("/api/matrix/auth", (req, res) => {
  const { pin } = req.body || {};
  if (!pin && pin !== 0) {
    return res.status(400).json({ ok: false, error: "Please enter your matrix PIN" });
  }

  const cleanPin = String(pin).trim();
  const inst = findMatrixByPin(cleanPin);

  if (!inst) {
    return res.status(401).json({ ok: false, error: "Incorrect PIN code. Please verify with your host." });
  }

  // Create high-entropy session token
  const token = crypto.randomBytes(24).toString("hex");
  matrixSessions.set(token, {
    instanceId: inst.id,
    createdAt: Date.now()
  });

  // Return matrix specs — notice PIN is NEVER sent back in response
  return res.json({
    ok: true,
    token,
    matrix: {
      id:         inst.id,
      name:       inst.name,
      cols:       inst.cols || 16,
      rows:       inst.rows || 16,
      ledCount:   inst.ledCount || (inst.cols * inst.rows) || 256,
      serpentine: !!inst.serpentine,
      isMatrix:   !!inst.isMatrix
    }
  });
});

// Validate session and retrieve current matrix canvas
app.get("/api/matrix/session", (req, res) => {
  const sess = getMatrixSession(req);
  if (!sess) {
    return res.status(401).json({ ok: false, error: "Invalid or expired session. Please enter PIN again." });
  }

  const inst = sess.instance;
  const canvas = instanceCanvases.get(inst.id) || [];
  return res.json({
    ok: true,
    matrix: {
      id:         inst.id,
      name:       inst.name,
      cols:       inst.cols || 16,
      rows:       inst.rows || 16,
      ledCount:   inst.ledCount || (inst.cols * inst.rows) || 256,
      serpentine: !!inst.serpentine,
      isMatrix:   !!inst.isMatrix
    },
    canvas,
    users: sseClients.size
  });
});

// Fetch current canvas for active matrix session
app.get("/api/matrix/canvas", (req, res) => {
  const sess = getMatrixSession(req);
  if (!sess) {
    return res.status(401).json({ ok: false, error: "Authentication required" });
  }
  const canvas = instanceCanvases.get(sess.instanceId) || [];
  return res.json({ ok: true, canvas, users: sseClients.size });
});

// Paint pixels on the matrix assigned to this PIN session
app.post("/api/matrix/send", async (req, res) => {
  const sess = getMatrixSession(req);
  if (!sess) {
    return res.status(401).json({ ok: false, error: "Authentication required" });
  }

  const inst = sess.instance;
  const instId = inst.id;
  const canvas = instanceCanvases.get(instId);
  if (!canvas) {
    return res.status(404).json({ ok: false, error: "Canvas not found for this matrix" });
  }

  const { deltas, pixels, brightness } = req.body || {};
  const changes = [];

  // Handle coordinates (col, row) or linear ledIndex
  if (Array.isArray(deltas) && deltas.length > 0) {
    for (const item of deltas) {
      let physicalIdx = -1;
      if (item.col !== undefined && item.row !== undefined) {
        physicalIdx = getPhysicalLedIndex(inst, item.col, item.row);
      } else if (item.ledIndex !== undefined) {
        physicalIdx = item.ledIndex;
      }

      if (physicalIdx >= 0 && physicalIdx < canvas.length) {
        const rgb = [item.r ?? 0, item.g ?? 0, item.b ?? 0];
        canvas[physicalIdx] = rgb;
        changes.push({
          instanceId: instId,
          ledIndex: physicalIdx,
          col: item.col,
          row: item.row,
          r: rgb[0],
          g: rgb[1],
          b: rgb[2]
        });
        dirtyInstances.add(instId);
      }
    }
  } else if (Array.isArray(pixels) && pixels.length > 0) {
    pixels.forEach((rgb, i) => {
      if (i < canvas.length && rgb) {
        canvas[i] = rgb;
        changes.push({ instanceId: instId, ledIndex: i, r: rgb[0], g: rgb[1], b: rgb[2] });
      }
    });
    dirtyInstances.add(instId);
  }

  if (changes.length > 0) {
    lastUserInteractionTime = Date.now();
    broadcastSse("delta", changes);
    broadcastSse("matrix_delta", { instanceId: instId, changes });
    livePausedInstances.delete(instId);
    scheduleWledFlush(instId);
  }

  if (brightness !== undefined && brightness !== null) {
    const bri = Math.max(0, Math.min(255, parseInt(brightness, 10)));
    saveConfig({ brightness: bri });
    if (inst.ip) {
      fetch(`http://${inst.ip}/json/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on: true, bri }),
        signal: AbortSignal.timeout(2000),
      }).catch(() => {});
    }
  }

  return res.json({ ok: true, changedCount: changes.length });
});

// Clear only the matrix assigned to this PIN session
app.post("/api/matrix/clear", async (req, res) => {
  const sess = getMatrixSession(req);
  if (!sess) {
    return res.status(401).json({ ok: false, error: "Authentication required" });
  }

  const inst = sess.instance;
  const instId = inst.id;
  const count = inst.ledCount || (inst.cols * inst.rows) || 256;
  instanceCanvases.set(instId, Array.from({ length: count }, () => [0, 0, 0]));
  livePausedInstances.add(instId);

  const cfg = loadConfig();
  const releaseLive = req.body?.releaseLive !== undefined
    ? !!req.body.releaseLive
    : (cfg.releaseLiveOnClear !== false);

  if (inst.ip) {
    if (releaseLive) {
      fetch(`http://${inst.ip}/json/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ live: false }),
        signal: AbortSignal.timeout(2000)
      }).catch(() => {});
    } else {
      const blank = Array.from({ length: count }, () => [0, 0, 0]);
      sendUdpPixelsDirect(inst.ip, inst.udpPort || 21329, blank, 1).catch(() => {});
    }
  }

  const devicesObj = {};
  for (const [id, canvas] of instanceCanvases.entries()) devicesObj[id] = canvas;

  lastUserInteractionTime = Date.now();
  broadcastSse("matrix_clear", { instanceId: instId, liveReleased: releaseLive });
  broadcastSse("clear", { devices: devicesObj, instanceId: instId, liveReleased: releaseLive });

  return res.json({ ok: true, cleared: true, instanceId: instId, liveReleased: releaseLive });
});

// Query live rendered pixels from physical matrix controller
app.post("/api/matrix/sync", async (req, res) => {
  const sess = getMatrixSession(req);
  if (!sess) {
    return res.status(401).json({ ok: false, error: "Authentication required" });
  }

  const inst = sess.instance;
  if (!inst.ip) {
    return res.status(400).json({ ok: false, error: "No IP address configured for this matrix" });
  }

  try {
    const px = await fetchWledPixels(inst.ip, 2000);
    if (Array.isArray(px) && px.length > 0) {
      instanceCanvases.set(inst.id, px);
      lastUserInteractionTime = Date.now();
      broadcastSse("matrix_sync", { instanceId: inst.id, canvas: px });
      return res.json({ ok: true, pixelCount: px.length, canvas: px });
    } else {
      return res.json({ ok: false, error: "No pixels received from WLED liveview" });
    }
  } catch (err) {
    return res.status(502).json({ ok: false, error: `Could not reach ${inst.ip}: ${err.message}` });
  }
});

// ── Creation Gallery APIs (Saved Art & Long-Term Memory) ───────────────────────

// 1. List saved artworks
app.get("/api/gallery", (_req, res) => {
  const gallery = loadGallery();
  return res.json({ ok: true, gallery });
});

// 2. Save artwork to persistent gallery
app.post("/api/gallery", (req, res) => {
  const sess = getMatrixSession(req);
  let { title, author, pixels, cols, rows, matrixId } = req.body || {};

  const targetInstId = matrixId || sess?.instanceId || "inst_1";
  const cfg = loadConfig();
  const inst = cfg.instances.find(i => i.id === targetInstId) || cfg.instances[0];

  if (!pixels || !Array.isArray(pixels) || pixels.length === 0) {
    // If pixels not explicitly passed, grab current canvas of the target matrix
    const canvas = instanceCanvases.get(targetInstId);
    if (!canvas || canvas.length === 0) {
      return res.status(400).json({ ok: false, error: "No pixels available to save" });
    }
    pixels = canvas.map(rgb => [...rgb]);
  }

  const cleanTitle = (typeof title === "string" && title.trim())
    ? title.trim().slice(0, 48)
    : `Creation #${Date.now().toString().slice(-4)}`;
  const cleanAuthor = (typeof author === "string" && author.trim())
    ? author.trim().slice(0, 32)
    : "Guest Artist";

  const gallery = loadGallery();
  const newItem = {
    id: `art_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: cleanTitle,
    author: cleanAuthor,
    createdAt: new Date().toISOString(),
    matrixId: targetInstId,
    matrixName: inst?.name || "WLED Matrix",
    cols: cols || inst?.cols || 16,
    rows: rows || inst?.rows || 16,
    pixels: pixels
  };

  gallery.unshift(newItem); // newest first
  saveGallery(gallery);

  broadcastSse("gallery_updated", { count: gallery.length, latest: newItem });
  return res.json({ ok: true, artwork: newItem });
});

// 3. Load & apply artwork from gallery onto active matrix & physical LEDs
app.post("/api/gallery/:id/apply", async (req, res) => {
  const sess = getMatrixSession(req);
  const gallery = loadGallery();
  const art = gallery.find(a => a.id === req.params.id);
  if (!art) {
    return res.status(404).json({ ok: false, error: "Artwork not found in gallery" });
  }

  const cfg = loadConfig();
  const targetId = req.body?.instanceId || sess?.instanceId || art.matrixId || cfg.instances[0]?.id || "inst_1";
  const inst = cfg.instances.find(i => i.id === targetId);

  if (!inst) {
    return res.status(404).json({ ok: false, error: "Target matrix not found" });
  }

  const count = inst.ledCount || (inst.cols * inst.rows) || 256;
  let canvas = instanceCanvases.get(targetId);
  if (!canvas || canvas.length !== count) {
    canvas = Array.from({ length: count }, () => [0, 0, 0]);
    instanceCanvases.set(targetId, canvas);
  }

  // Copy saved pixels to canvas (safe bounds-checked)
  for (let i = 0; i < count; i++) {
    if (art.pixels[i]) {
      canvas[i] = [...art.pixels[i]];
    } else {
      canvas[i] = [0, 0, 0];
    }
  }

  dirtyInstances.add(targetId);
  livePausedInstances.delete(targetId);
  scheduleWledFlush(targetId);

  lastUserInteractionTime = Date.now(); // reset slideshow idle countdown

  // Broadcast to all connected web clients
  broadcastSse("matrix_sync", { instanceId: targetId, canvas });
  broadcastSse("canvas", instanceCanvases.get(cfg.instances[0]?.id) || []);

  return res.json({
    ok: true,
    applied: true,
    instanceId: targetId,
    matrixName: inst.name,
    title: art.title
  });
});

// 4. Delete artwork from gallery
app.delete("/api/gallery/:id", (req, res) => {
  let gallery = loadGallery();
  const initialLen = gallery.length;
  gallery = gallery.filter(a => a.id !== req.params.id);
  if (gallery.length === initialLen) {
    return res.status(404).json({ ok: false, error: "Artwork not found" });
  }
  saveGallery(gallery);
  broadcastSse("gallery_updated", { count: gallery.length });
  return res.json({ ok: true, deleted: true });
});

// 5. Export artwork directly to native WLED controller flash preset
app.post("/api/gallery/:id/export-preset", async (req, res) => {
  const sess = getMatrixSession(req);
  const gallery = loadGallery();
  const art = gallery.find(a => a.id === req.params.id);
  if (!art) {
    return res.status(404).json({ ok: false, error: "Artwork not found" });
  }

  const cfg = loadConfig();
  const targetId = req.body?.instanceId || sess?.instanceId || art.matrixId || cfg.instances[0]?.id;
  const inst = cfg.instances.find(i => i.id === targetId);

  if (!inst || !inst.ip) {
    return res.status(400).json({ ok: false, error: "No controller IP configured for this matrix" });
  }

  // First flush current artwork pixels onto the physical matrix
  const count = inst.ledCount || (inst.cols * inst.rows) || 256;
  let canvas = instanceCanvases.get(inst.id);
  if (!canvas || canvas.length !== count) {
    canvas = Array.from({ length: count }, () => [0, 0, 0]);
    instanceCanvases.set(inst.id, canvas);
  }
  for (let i = 0; i < count; i++) {
    canvas[i] = art.pixels[i] ? [...art.pixels[i]] : [0, 0, 0];
  }
  await sendToInstance(inst, 255).catch(() => {});

  // Find next available preset slot (1..250) on WLED
  let targetPresetId = 1;
  try {
    const pRes = await fetch(`http://${inst.ip}/presets.json`, { signal: AbortSignal.timeout(2000) });
    if (pRes.ok) {
      const presets = await pRes.json();
      const existingIds = Object.keys(presets).map(k => parseInt(k, 10)).filter(k => k > 0);
      while (existingIds.includes(targetPresetId)) {
        targetPresetId++;
      }
    }
  } catch {}

  // Save preset into WLED controller flash storage
  try {
    const saveRes = await fetch(`http://${inst.ip}/json/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        psave: targetPresetId,
        n: art.title.slice(0, 32),
        ib: true,
        sb: true
      }),
      signal: AbortSignal.timeout(3000)
    });

    if (saveRes.ok) {
      return res.json({
        ok: true,
        savedToWled: true,
        ip: inst.ip,
        presetId: targetPresetId,
        presetName: art.title
      });
    } else {
      return res.status(502).json({ ok: false, error: `WLED controller returned HTTP ${saveRes.status}` });
    }
  } catch (err) {
    return res.status(502).json({ ok: false, error: `Could not reach ${inst.ip}: ${err.message}` });
  }
});

// ── Ambient Art Frame / Slideshow Engine ───────────────────────────────────────
let currentSlideshowIdx = 0;
setInterval(async () => {
  const cfg = loadConfig();
  if (!cfg.slideshowEnabled) return;

  const idleMs = (cfg.slideshowIdleMinutes || 3) * 60 * 1000;
  if (Date.now() - lastUserInteractionTime < idleMs) return;

  const gallery = loadGallery();
  if (!gallery || gallery.length === 0) return;

  currentSlideshowIdx = (currentSlideshowIdx + 1) % gallery.length;
  const art = gallery[currentSlideshowIdx];
  if (!art || !Array.isArray(art.pixels)) return;

  const targetMatrices = cfg.instances.filter(i => i.isMatrix);
  for (const inst of targetMatrices) {
    const count = inst.ledCount || (inst.cols * inst.rows) || 256;
    let canvas = instanceCanvases.get(inst.id);
    if (!canvas || canvas.length !== count) {
      canvas = Array.from({ length: count }, () => [0, 0, 0]);
      instanceCanvases.set(inst.id, canvas);
    }
    for (let i = 0; i < count; i++) {
      canvas[i] = art.pixels[i] ? [...art.pixels[i]] : [0, 0, 0];
    }
    dirtyInstances.add(inst.id);
    scheduleWledFlush(inst.id);
    broadcastSse("matrix_sync", { instanceId: inst.id, canvas });
  }

  broadcastSse("slideshow_tick", {
    artwork: { id: art.id, title: art.title, author: art.author }
  });
}, 30000);

// ── Send Pixels API ───────────────────────────────────────────────────────────
app.post("/api/send", (req, res) => {
  const cfg = loadConfig();
  const sess = getMatrixSession(req);
  const { elementDeltas, deltas, delta, pixels, brightness, instanceId } = req.body;

  const targetInstId = instanceId || sess?.instanceId || cfg.instances[0]?.id || "inst_1";
  const changes = []; // Array of { instanceId, ledIndex, r, g, b }

  // 1. Element deltas from House painter: { elementDeltas: [ { elementId, pixelIdx, r, g, b }, ... ] }
  if (Array.isArray(elementDeltas) && elementDeltas.length > 0) {
    const elemMap = new Map((cfg.house?.elements || []).map(el => [el.id, el]));

    for (const item of elementDeltas) {
      const el = elemMap.get(item.elementId);
      if (!el) continue;
      const instId = el.instanceId || targetInstId;
      const canvas = instanceCanvases.get(instId);
      if (!canvas) continue;

      const pIdx = item.pixelIdx;
      if (pIdx < 0 || pIdx >= el.ledCount) continue;

      const physicalIdx = el.reverse
        ? (el.startLed + el.ledCount - 1 - pIdx)
        : (el.startLed + pIdx);

      if (physicalIdx >= 0 && physicalIdx < canvas.length) {
        const rgb = [item.r ?? 0, item.g ?? 0, item.b ?? 0];
        canvas[physicalIdx] = rgb;
        changes.push({ instanceId: instId, ledIndex: physicalIdx, r: rgb[0], g: rgb[1], b: rgb[2], elementId: item.elementId, pixelIdx: pIdx });
        dirtyInstances.add(instId);
      }
    }
  }
  // 2. Multi-instance deltas: { deltas: [ { instanceId, ledIndex, col, row, r, g, b }, ... ] }
  else if (Array.isArray(deltas) && deltas.length > 0) {
    for (const item of deltas) {
      const instId = item.instanceId || targetInstId;
      const inst = cfg.instances.find(i => i.id === instId);
      const canvas = instanceCanvases.get(instId);
      if (!canvas) continue;
      let idx = item.ledIndex;
      if (idx === undefined && item.col !== undefined && item.row !== undefined && inst) {
        idx = getPhysicalLedIndex(inst, item.col, item.row);
      }
      if (idx !== undefined && idx >= 0 && idx < canvas.length) {
        const rgb = [item.r ?? 0, item.g ?? 0, item.b ?? 0];
        canvas[idx] = rgb;
        changes.push({ instanceId: instId, ledIndex: idx, col: item.col, row: item.row, r: rgb[0], g: rgb[1], b: rgb[2] });
        dirtyInstances.add(instId);
      }
    }
  }
  // 3. Legacy multiplayer delta: { delta: [ [ledIndex, r, g, b], ... ] }
  else if (Array.isArray(delta) && delta.length > 0) {
    const canvas = instanceCanvases.get(targetInstId);
    if (canvas) {
      for (const [idx, r, g, b] of delta) {
        if (idx >= 0 && idx < canvas.length) {
          canvas[idx] = [r, g, b];
          changes.push({ instanceId: targetInstId, ledIndex: idx, r, g, b });
          dirtyInstances.add(targetInstId);
        }
      }
    }
  }
  // 4. Legacy single-player full canvas: { pixels: [ [r, g, b], ... ] }
  else if (Array.isArray(pixels) && pixels.length > 0) {
    const canvas = instanceCanvases.get(targetInstId);
    if (canvas) {
      pixels.forEach((rgb, i) => {
        if (i < canvas.length && rgb) {
          canvas[i] = rgb;
          changes.push({ instanceId: targetInstId, ledIndex: i, r: rgb[0], g: rgb[1], b: rgb[2] });
        }
      });
      dirtyInstances.add(targetInstId);
    }
  } else {
    return res.status(400).json({ ok: false, error: "No pixel changes provided" });
  }

  // Broadcast delta to connected SSE peers
  if (changes.length > 0 && sseClients.size > 0) {
    broadcastSse("delta", changes);
  }

  // Handle brightness updates across instances
  const bri = brightness ?? cfg.brightness;
  if (bri !== undefined && bri !== cfg.brightness) {
    saveConfig({ brightness: bri });
    for (const inst of cfg.instances) {
      if (inst.ip) {
        fetch(`http://${inst.ip}/json/state`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ on: true, bri }),
          signal: AbortSignal.timeout(2000),
        }).catch(() => {});
      }
    }
  }

  // Resume live streaming for painted instances
  for (const instId of dirtyInstances) {
    livePausedInstances.delete(instId);
  }

  // Schedule debounced UDP flush
  scheduleWledFlush();
  return res.json({ ok: true, changedCount: changes.length });
});

// ── Clear Strip API ───────────────────────────────────────────────────────────
app.post("/api/clear", async (req, res) => {
  const cfg = loadConfig();
  const sess = getMatrixSession(req);
  const targetId = req.body.instanceId || sess?.instanceId;
  const releaseLive = req.body.releaseLive !== undefined ? !!req.body.releaseLive : (cfg.releaseLiveOnClear !== false);

  const instancesToClear = targetId && targetId !== "all"
    ? cfg.instances.filter(i => i.id === targetId)
    : cfg.instances;

  for (const inst of instancesToClear) {
    const count = inst.ledCount || 256;
    instanceCanvases.set(inst.id, Array.from({ length: count }, () => [0, 0, 0]));
    livePausedInstances.add(inst.id);

    if (inst.ip) {
      if (releaseLive) {
        // Drop live UDP override on WLED so it returns to regular controls / presets
        fetch(`http://${inst.ip}/json/state`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ live: false }),
          signal: AbortSignal.timeout(2000)
        }).catch(() => {});
      } else {
        const blank = Array.from({ length: count }, () => [0, 0, 0]);
        sendUdpPixelsDirect(inst.ip, inst.udpPort || 21329, blank, 1).catch(() => {});
      }
    }
  }

  // Broadcast reset event to all clients
  const devicesObj = {};
  for (const [id, canvas] of instanceCanvases.entries()) {
    devicesObj[id] = canvas;
  }
  broadcastSse("clear", { devices: devicesObj, liveReleased: releaseLive });
  broadcastSse("canvas", instanceCanvases.get(cfg.instances[0]?.id) || []);

  return res.json({ ok: true, clearedInstances: instancesToClear.length, liveReleased: releaseLive });
});

// ── Presets API: Query WLED presets from all configured devices ────────────────
app.get("/api/presets", async (req, res) => {
  const cfg = loadConfig();
  const targetInstanceId = req.query.instanceId;

  const instancesToQuery = targetInstanceId && targetInstanceId !== "all"
    ? cfg.instances.filter(i => i.id === targetInstanceId)
    : cfg.instances;

  const results = await Promise.all(instancesToQuery.map(async inst => {
    if (!inst.ip) {
      return {
        instanceId: inst.id,
        instanceName: inst.name,
        ip: null,
        presets: [],
        error: "No IP configured"
      };
    }

    try {
      const r = await fetch(`http://${inst.ip}/presets.json`, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const presets = [];

      for (const [k, p] of Object.entries(data)) {
        const id = parseInt(k, 10);
        if (!id || id <= 0 || !p || typeof p !== "object") continue;
        presets.push({
          id,
          name: p.n || p.name || `Preset ${id}`,
          quickLabel: p.ql || String(id)
        });
      }
      presets.sort((a, b) => a.id - b.id);

      return {
        instanceId: inst.id,
        instanceName: inst.name,
        ip: inst.ip,
        presets,
        isLivePaused: livePausedInstances.has(inst.id)
      };
    } catch (err) {
      return {
        instanceId: inst.id,
        instanceName: inst.name,
        ip: inst.ip,
        presets: [],
        error: `Could not reach ${inst.ip}: ${err.message}`
      };
    }
  }));

  return res.json({ ok: true, instances: results });
});

// ── Query Current Rendered Pixels from WLED Liveview (WebSocket) ───────────────
function fetchWledPixels(ip, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let ws;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws?.close(); } catch {}
        reject(new Error(`Timeout querying liveview from ${ip}`));
      }
    }, timeoutMs);

    try {
      if (!WebSocket) {
        clearTimeout(timer);
        return reject(new Error("WebSocket client not available"));
      }

      ws = new WebSocket(`ws://${ip}/ws`);

      const handleBinary = (buf) => {
        if (buf && buf.length >= 2 && buf[0] === 76) { // ASCII 'L'
          resolved = true;
          clearTimeout(timer);
          try { ws?.close(); } catch {}
          const is2D = buf[1] === 2;
          const offset = is2D ? 4 : 2;
          const count = Math.floor((buf.length - offset) / 3);
          const px = [];
          for (let i = 0; i < count; i++) {
            px.push([buf[offset + i * 3], buf[offset + i * 3 + 1], buf[offset + i * 3 + 2]]);
          }
          resolve(px);
        }
      };

      if (typeof ws.on === "function") {
        ws.on("open", () => {
          try { ws.send(JSON.stringify({ lv: true })); } catch {}
        });
        ws.on("message", (data) => {
          if (Buffer.isBuffer(data)) {
            handleBinary(data);
          } else if (data instanceof ArrayBuffer) {
            handleBinary(Buffer.from(data));
          }
        });
        ws.on("error", (err) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            reject(err);
          }
        });
      } else {
        ws.onopen = () => {
          try { ws.send(JSON.stringify({ lv: true })); } catch {}
        };
        ws.onmessage = async (evt) => {
          try {
            if (evt.data instanceof Blob) {
              const buf = Buffer.from(await evt.data.arrayBuffer());
              handleBinary(buf);
            } else if (evt.data instanceof ArrayBuffer) {
              handleBinary(Buffer.from(evt.data));
            } else if (Buffer.isBuffer(evt.data)) {
              handleBinary(evt.data);
            }
          } catch (e) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              reject(e);
            }
          }
        };
        ws.onerror = (err) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            reject(err);
          }
        };
      }
    } catch (err) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(err);
      }
    }
  });
}

// ── Apply WLED Preset API ─────────────────────────────────────────────────────
app.post("/api/presets/apply", async (req, res) => {
  const cfg = loadConfig();
  const { instanceId, presetId } = req.body;

  if (presetId === undefined || presetId === null) {
    return res.status(400).json({ ok: false, error: "presetId is required" });
  }

  const pId = parseInt(presetId, 10);
  const targets = instanceId && instanceId !== "all"
    ? cfg.instances.filter(i => i.id === instanceId)
    : cfg.instances;

  if (targets.length === 0) {
    return res.status(404).json({ ok: false, error: "Target instance not found" });
  }

  const applied = [];
  for (const inst of targets) {
    if (!inst.ip) continue;
    try {
      const r = await fetch(`http://${inst.ip}/json/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on: true, ps: pId, live: false }),
        signal: AbortSignal.timeout(3000)
      });
      if (r.ok) {
        livePausedInstances.add(inst.id);
        applied.push(inst.name || inst.id);
      }
    } catch (err) {
      console.warn(`Failed to apply preset ${pId} on ${inst.ip}:`, err.message);
    }
  }

  // Allow WLED a brief moment (~500ms) to switch preset and render initial frames
  await new Promise(r => setTimeout(r, 500));

  // Query actual live pixels from target instances
  await Promise.allSettled(targets.map(async inst => {
    if (!inst.ip) return;
    try {
      const px = await fetchWledPixels(inst.ip, 1800);
      if (Array.isArray(px) && px.length > 0) {
        instanceCanvases.set(inst.id, px);
      }
    } catch (err) {
      console.warn(`Could not query liveview on ${inst.ip}:`, err.message);
    }
  }));

  const devicesObj = {};
  for (const [id, canvas] of instanceCanvases.entries()) {
    devicesObj[id] = canvas;
  }

  // Broadcast sync event with the live rendered pixels
  broadcastSse("devices_sync", { devices: devicesObj, presetId: pId, instanceId });
  broadcastSse("preset_applied", { instanceId, presetId: pId, applied, devices: devicesObj });
  broadcastSse("canvas", instanceCanvases.get(cfg.instances[0]?.id) || []);

  // Follow-up background sync at 1400ms to catch transitions / moving effect settling
  setTimeout(async () => {
    try {
      let updated = false;
      await Promise.allSettled(targets.map(async inst => {
        if (!inst.ip) return;
        try {
          const px = await fetchWledPixels(inst.ip, 1800);
          if (Array.isArray(px) && px.length > 0) {
            instanceCanvases.set(inst.id, px);
            updated = true;
          }
        } catch {}
      }));
      if (updated) {
        const devObj = {};
        for (const [id, canvas] of instanceCanvases.entries()) devObj[id] = canvas;
        broadcastSse("devices_sync", { devices: devObj, presetId: pId });
      }
    } catch {}
  }, 1400);

  return res.json({ ok: true, presetId: pId, appliedInstances: applied, devices: devicesObj });
});

// ── Manual / Periodic Sync Lights Endpoint ────────────────────────────────────
app.post("/api/sync-lights", async (req, res) => {
  const cfg = loadConfig();
  const targetId = req.body?.instanceId;
  const targets = targetId && targetId !== "all"
    ? cfg.instances.filter(i => i.id === targetId)
    : cfg.instances;

  const synced = [];
  await Promise.allSettled(targets.map(async inst => {
    if (!inst.ip) return;
    try {
      const px = await fetchWledPixels(inst.ip, 2000);
      if (Array.isArray(px) && px.length > 0) {
        instanceCanvases.set(inst.id, px);
        synced.push(inst.name || inst.id);
      }
    } catch (err) {
      console.warn(`Sync lights error for ${inst.ip}:`, err.message);
    }
  }));

  const devicesObj = {};
  for (const [id, canvas] of instanceCanvases.entries()) {
    devicesObj[id] = canvas;
  }

  broadcastSse("devices_sync", { devices: devicesObj });
  broadcastSse("canvas", instanceCanvases.get(cfg.instances[0]?.id) || []);

  return res.json({ ok: true, synced, devices: devicesObj });
});

// ── Release Live Control API (Restore regular WLED controls) ──────────────────
app.post("/api/live/release", async (req, res) => {
  const cfg = loadConfig();
  const { instanceId } = req.body || {};

  const targets = instanceId && instanceId !== "all"
    ? cfg.instances.filter(i => i.id === instanceId)
    : cfg.instances;

  const released = [];
  for (const inst of targets) {
    if (!inst.ip) continue;
    try {
      const r = await fetch(`http://${inst.ip}/json/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ live: false }),
        signal: AbortSignal.timeout(2000)
      });
      if (r.ok) {
        livePausedInstances.add(inst.id);
        const count = inst.ledCount || 256;
        instanceCanvases.set(inst.id, Array.from({ length: count }, () => [0, 0, 0]));
        released.push(inst.name || inst.id);
      }
    } catch (err) {
      console.warn(`Failed to release live on ${inst.ip}:`, err.message);
    }
  }

  const devicesObj = {};
  for (const [id, canvas] of instanceCanvases.entries()) {
    devicesObj[id] = canvas;
  }
  broadcastSse("live_released", { released });
  broadcastSse("clear", { devices: devicesObj, liveReleased: true });

  return res.json({
    ok: true,
    message: "Live mode released. WLED regular controls restored.",
    releasedInstances: released
  });
});

function sendUdpPixelsDirect(ip, port, pixels, timeoutSecs = 1) {
  const buf = Buffer.alloc(2 + pixels.length * 3);
  buf[0] = 2;
  buf[1] = timeoutSecs;
  return sendUdpBuffer(buf, port, ip);
}

// ── Physical String Test / Flash Endpoint ──────────────────────────────────────
app.post("/api/admin/test-element", async (req, res) => {
  const cfg = loadConfig();
  const { elementId, instanceId, startLed = 0, ledCount = 20, color = [255, 255, 255], durationMs = 2500 } = req.body;

  let inst;
  let sLed = startLed;
  let count = ledCount;

  if (elementId && cfg.house?.elements) {
    const el = cfg.house.elements.find(e => e.id === elementId);
    if (el) {
      inst = cfg.instances.find(i => i.id === el.instanceId);
      sLed = el.startLed;
      count = el.ledCount;
    }
  }

  if (!inst && instanceId) {
    inst = cfg.instances.find(i => i.id === instanceId);
  }
  if (!inst) inst = cfg.instances[0];

  if (!inst || !inst.ip) {
    return res.status(400).json({ ok: false, error: "No valid WLED controller found" });
  }

  const origCanvas = instanceCanvases.get(inst.id) || [];
  const testCanvas = origCanvas.map(rgb => [...rgb]);
  for (let i = sLed; i < sLed + count && i < testCanvas.length; i++) {
    testCanvas[i] = color;
  }

  // Send temporary test pattern via UDP
  instanceCanvases.set(inst.id, testCanvas);
  await sendToInstance(inst, 3).catch(() => {});

  // Restore original canvas state after duration
  setTimeout(async () => {
    instanceCanvases.set(inst.id, origCanvas);
    await sendToInstance(inst, 255).catch(() => {});
  }, durationMs);

  return res.json({ ok: true, testing: { ip: inst.ip, startLed: sLed, ledCount: count } });
});

// ── Ping + Auto-Detect WLED Device ─────────────────────────────────────────────
app.get(["/api/ping", "/api/admin/ping"], async (req, res) => {
  const ip = req.query.ip || req.query.wledIp || loadConfig().instances[0]?.ip;
  if (!ip) return res.status(400).json({ ok: false, error: "ip parameter required" });

  try {
    const [infoRes, stateRes] = await Promise.all([
      fetch(`http://${ip}/json/info`, { signal: AbortSignal.timeout(3000) }),
      fetch(`http://${ip}/json/state`, { signal: AbortSignal.timeout(3000) }).catch(() => null)
    ]);

    if (!infoRes.ok) return res.status(502).json({ ok: false, error: `WLED returned status ${infoRes.status}` });
    const info  = await infoRes.json();
    const state = stateRes?.ok ? await stateRes.json() : null;

    const matrix   = info?.leds?.matrix;
    const isMatrix = !!(matrix?.w && matrix?.h && matrix.h > 1);
    const cols     = isMatrix ? matrix.w : (info?.leds?.count ?? 30);
    const rows     = isMatrix ? matrix.h : 1;
    const ledCount = info?.leds?.count ?? cols * rows;

    const segments = (state?.seg || []).map((s, idx) => ({
      id:    idx,
      start: s.start ?? 0,
      stop:  s.stop ?? ledCount,
      len:   (s.stop ?? ledCount) - (s.start ?? 0),
      name:  s.n || `Segment ${idx}`
    }));

    return res.json({
      ok: true,
      info,
      segments,
      detected: {
        ip,
        name:     info?.name || ip,
        isMatrix,
        cols,
        rows,
        ledCount,
        ver:      info?.ver,
        udpPort:  info?.udpport || 21329
      }
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: `Could not reach WLED at ${ip}: ${err.message}` });
  }
});

// ── Device Discovery Stream (mDNS + Subnet Scan) ──────────────────────────────
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
    return {
      ip,
      name:     info?.name ?? ip,
      isMatrix,
      cols,
      rows,
      ledCount,
      ver:      info?.ver ?? null,
      udpPort:  info?.udpport ?? 21329
    };
  }

  function offerDevice(ip, info) {
    if (found.has(ip) || closed) return;
    found.add(ip);
    emit("device", parseDevice(ip, info));
  }

  // 1. mDNS Discovery (Bonjour)
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
      console.warn("mDNS init error:", e.message);
    }

    setTimeout(() => {
      try { browser?.stop(); bonjour?.destroy(); } catch {}
      mdnsDone = true;
    }, MDNS_TIMEOUT);
  } else {
    mdnsDone = true;
  }

  // 2. Subnet Scan
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

  if (!mdnsDone) await new Promise(r => setTimeout(r, MDNS_TIMEOUT));
  emit("done", { count: found.size });
  res.end();
});

// ── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🏡 WLED House & Pixel Painter`);
  console.log(`   Public Painter: http://localhost:${PORT}/`);
  console.log(`   Admin Panel:    http://localhost:${PORT}/admin`);
  console.log(`   Config Path:    ${CONFIG_PATH}\n`);
});
