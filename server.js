const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 9000;
const DATA_DIR = path.join(__dirname, "data");
const NOTES_FILE = path.join(DATA_DIR, "notes.json");
/** Allowed browser origin for GitHub Pages → API calls. Default *; set e.g. https://yourname.github.io for stricter security. */
const CORS_ORIGIN = process.env.BILLBOARD_CORS_ORIGIN || "*";

let notes = [];

function loadNotes() {
  try {
    if (fs.existsSync(NOTES_FILE)) {
      const raw = fs.readFileSync(NOTES_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        notes = parsed;
        return;
      }
    }
  } catch (e) {
    console.warn("loadNotes:", e.message);
  }
  notes = [];
}

function saveNotes() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(NOTES_FILE, JSON.stringify(notes), "utf8");
  } catch (e) {
    console.error("saveNotes:", e.message);
  }
}

loadNotes();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function safeJoin(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const full = path.join(__dirname, relative);
  if (!full.startsWith(__dirname)) return null;
  return full;
}

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  if (CORS_ORIGIN !== "*") res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

function applyClientMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "addNote" && msg.note && typeof msg.note.id === "string") {
    const exists = notes.some((n) => n.id === msg.note.id);
    if (!exists) {
      notes.push(msg.note);
      saveNotes();
      broadcast({ type: "addNote", note: msg.note });
    }
    return;
  }
  if (msg.type === "updateNote" && typeof msg.id === "string") {
    const n = notes.find((x) => x.id === msg.id);
    if (n) {
      n.text = typeof msg.text === "string" ? msg.text : "";
      saveNotes();
      broadcast({ type: "updateNote", id: msg.id, text: n.text });
    }
  }
}

const server = http.createServer((req, res) => {
  /* Let the ws library handle upgrades; never send a normal HTTP response. */
  if (String(req.headers.upgrade || "").toLowerCase() === "websocket") {
    return;
  }

  const urlPath = (req.url || "/").split("?")[0];

  if (req.method === "OPTIONS" && (urlPath === "/api/state" || urlPath === "/api/message")) {
    corsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && urlPath === "/api/state") {
    corsHeaders(res);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ notes }));
    return;
  }

  if (req.method === "POST" && urlPath === "/api/message") {
    const maxLen = 1_000_000;
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxLen) body = body.slice(0, maxLen);
    });
    req.on("end", () => {
      try {
        applyClientMessage(JSON.parse(body || "{}"));
      } catch {
        /* ignore */
      }
      corsHeaders(res);
      res.writeHead(204);
      res.end();
    });
    return;
  }

  const fullPath = safeJoin(req.url || "/");
  if (!fullPath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "init", notes: [...notes] }));

  ws.on("message", (raw) => {
    try {
      applyClientMessage(JSON.parse(raw.toString()));
    } catch {
      /* ignore */
    }
  });
});

server.listen(PORT, () => {
  console.log(`Billboard: http://localhost:${PORT}`);
});
