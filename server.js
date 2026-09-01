// Boxed In — multiplayer dots & boxes.
// Zero dependencies: Node's built-in http + Server-Sent Events.
// The server is authoritative: it owns seats, turn order and the 30s turn clock.
const http = require("http");
const fs = require("fs");
const path = require("path");

const TURN_MS = 20000;
const REACT_COOLDOWN_MS = 400;
const COLORS = ["#E4572E", "#2E86AB", "#379956", "#8A4FD3", "#D81E77", "#0F8B8D"];

let G = { phase: "setup" };
const clients = new Set();

/* ---------- helpers ---------- */

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function initialOf(name) {
  const t = (name || "").trim();
  return (t ? t[0] : "?").toUpperCase();
}

// State sent to browsers: player tokens are stripped out.
function publicState() {
  if (G.phase === "setup") return { phase: "setup", now: Date.now() };
  return {
    phase: G.phase,
    gameId: G.gameId,
    seats: G.seats,
    N: G.N,
    minutes: G.minutes,
    players: G.players.map((p) =>
      p ? { name: p.name, color: p.color, initial: p.initial, score: p.score } : null
    ),
    hE: G.hE,
    vE: G.vE,
    boxes: G.boxes,
    turn: G.turn,
    claimed: G.claimed,
    turnStartedAt: G.turnStartedAt || null,
    turnMs: TURN_MS,
    lastEvent: G.lastEvent || null,
    now: Date.now()
  };
}

function broadcast() {
  const msg = "data: " + JSON.stringify({ state: publicState() }) + "\n\n";
  for (const res of clients) res.write(msg);
}

// Reactions are fire-and-forget: not part of game state, just relayed to everyone.
const ALLOWED_REACTIONS = ["🍅", "😭", "💀", "😏", "🫠", "🔥", "😱", "🤡"];
const lastReactAt = new Map();

function relayReaction(emoji, name) {
  const msg = "data: " + JSON.stringify({ reaction: { emoji, name, at: Date.now() } }) + "\n\n";
  for (const res of clients) res.write(msg);
}

function createGame(seats, dots) {
  const N = dots;
  G = {
    phase: "lobby",
    gameId: Math.random().toString(36).slice(2, 10),
    seats,
    N,
    minutes: dots === 6 ? 10 : dots === 8 ? 15 : 20,
    palette: shuffle(COLORS.slice()),
    players: Array(seats).fill(null),
    hE: Array.from({ length: N }, () => Array(N - 1).fill(-1)),
    vE: Array.from({ length: N - 1 }, () => Array(N).fill(-1)),
    boxes: Array.from({ length: N - 1 }, () => Array(N - 1).fill(-1)),
    turn: 0,
    claimed: 0,
    turnStartedAt: null,
    lastEvent: null
  };
}

function joinGame(name, token) {
  if (!G.players) return { error: "not_open" };

  // Reclaiming a seat after a refresh — works mid-game too.
  if (token) {
    const existing = G.players.findIndex((p) => p && p.token === token);
    if (existing >= 0) return { seat: existing, token };
  }

  if (G.phase !== "lobby") return { error: "not_open" };

  const seat = G.players.findIndex((p) => p === null);
  if (seat < 0) return { error: "full" };

  const newToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
  G.players[seat] = {
    name: String(name || "").trim().slice(0, 16) || "Player " + (seat + 1),
    color: G.palette[seat],
    initial: initialOf(name) === "?" ? "P" : initialOf(name),
    score: 0,
    token: newToken
  };

  // Everyone's in — kick off.
  if (G.players.every((p) => p !== null)) {
    G.phase = "playing";
    G.turn = 0;
    G.turnStartedAt = Date.now();
    G.lastEvent = { type: "start" };
  }
  return { seat, token: newToken };
}

function boxComplete(r, c) {
  return (
    G.hE[r][c] !== -1 && G.hE[r + 1][c] !== -1 && G.vE[r][c] !== -1 && G.vE[r][c + 1] !== -1
  );
}

function freeEdges() {
  const out = [];
  for (let r = 0; r < G.N; r++)
    for (let c = 0; c < G.N - 1; c++) if (G.hE[r][c] === -1) out.push(["h", r, c]);
  for (let r = 0; r < G.N - 1; r++)
    for (let c = 0; c < G.N; c++) if (G.vE[r][c] === -1) out.push(["v", r, c]);
  return out;
}

// Applies a legal move for the player whose turn it is. Returns false if illegal.
function applyMove(seat, type, r, c, timedOut) {
  if (G.phase !== "playing" || seat !== G.turn) return false;
  const store = type === "h" ? G.hE : G.vE;
  if (!store[r] || store[r][c] === undefined || store[r][c] !== -1) return false;

  store[r][c] = seat;
  const player = G.players[seat];

  const cand = type === "h" ? [[r - 1, c], [r, c]] : [[r, c - 1], [r, c]];
  const done = [];
  for (const [br, bc] of cand) {
    if (br < 0 || bc < 0 || br >= G.N - 1 || bc >= G.N - 1) continue;
    if (G.boxes[br][bc] === -1 && boxComplete(br, bc)) done.push([br, bc]);
  }

  if (done.length) {
    player.score += done.length;
    G.claimed += done.length;
    for (const [br, bc] of done) G.boxes[br][bc] = seat;
    G.lastEvent = { type: "score", pi: seat, count: done.length, boxes: done, timedOut: !!timedOut };
    if (G.claimed === (G.N - 1) * (G.N - 1)) {
      G.phase = "over";
      G.turnStartedAt = null;
      return true;
    }
    // Completing a square earns another turn.
    G.turnStartedAt = Date.now();
  } else {
    G.lastEvent = { type: timedOut ? "timeout" : "move", pi: seat };
    G.turn = (seat + 1) % G.seats;
    G.turnStartedAt = Date.now();
  }
  return true;
}

// 30s elapsed: play a random free line for whoever was thinking.
function autoPlay() {
  const free = freeEdges();
  if (!free.length) return;
  const [type, r, c] = free[Math.floor(Math.random() * free.length)];
  applyMove(G.turn, type, r, c, true);
  broadcast();
}

setInterval(() => {
  if (G.phase !== "playing" || !G.turnStartedAt) return;
  if (Date.now() - G.turnStartedAt >= TURN_MS) autoPlay();
}, 400);

/* ---------- http ---------- */

function readJson(req, res, done) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1e6) req.destroy();
  });
  req.on("end", () => {
    try {
      done(JSON.parse(body || "{}"));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":"bad_json"}');
    }
  });
}

function sendJson(res, obj, code) {
  res.writeHead(code || 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (req.method === "GET" && url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("data: " + JSON.stringify({ state: publicState() }) + "\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "POST" && url === "/create") {
    readJson(req, res, (msg) => {
      const seats = Math.max(2, Math.min(6, parseInt(msg.seats, 10) || 2));
      const dots = [6, 8, 10].includes(msg.dots) ? msg.dots : 6;
      createGame(seats, dots);
      broadcast();
      sendJson(res, { ok: true });
    });
    return;
  }

  if (req.method === "POST" && url === "/join") {
    readJson(req, res, (msg) => {
      const result = joinGame(msg.name, msg.token);
      if (result.error) return sendJson(res, result, 409);
      broadcast();
      sendJson(res, result);
    });
    return;
  }

  if (req.method === "POST" && url === "/move") {
    readJson(req, res, (msg) => {
      const seat = G.players ? G.players.findIndex((p) => p && p.token === msg.token) : -1;
      if (seat < 0) return sendJson(res, { error: "not_a_player" }, 403);
      if (seat !== G.turn) return sendJson(res, { error: "not_your_turn" }, 409);
      const ok = applyMove(seat, msg.type, msg.r, msg.c, false);
      if (!ok) return sendJson(res, { error: "illegal" }, 409);
      broadcast();
      sendJson(res, { ok: true });
    });
    return;
  }

  if (req.method === "POST" && url === "/react") {
    readJson(req, res, (msg) => {
      if (!ALLOWED_REACTIONS.includes(msg.emoji)) {
        return sendJson(res, { error: "unknown_reaction" }, 400);
      }
      const key = String(msg.token || "anon").slice(0, 64);
      const now = Date.now();
      if (now - (lastReactAt.get(key) || 0) < REACT_COOLDOWN_MS) {
        return sendJson(res, { error: "too_fast" }, 429);
      }
      lastReactAt.set(key, now);

      // Name the sender if their token matches a seat; spectators stay anonymous.
      let name = "Someone";
      if (G.players) {
        const seat = G.players.findIndex((p) => p && p.token === msg.token);
        if (seat >= 0) name = G.players[seat].name;
      }
      relayReaction(msg.emoji, name);
      sendJson(res, { ok: true });
    });
    return;
  }

  if (req.method === "POST" && url === "/reset") {
    G = { phase: "setup" };
    broadcast();
    return sendJson(res, { ok: true });
  }

  if (req.method === "GET" && (url === "/" || url === "/index.html")) {
    fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("error");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// Heartbeat so proxies don't drop idle streams.
setInterval(() => {
  for (const res of clients) res.write(": ping\n\n");
}, 25000);

const port = process.env.PORT || 3000;
server.listen(port, () => console.log("Boxed In listening on " + port));
