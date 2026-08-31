// Boxed In — multiplayer dots & boxes server.
// Zero dependencies: Node's built-in http + Server-Sent Events for live sync.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PUBLIC = __dirname;

// One shared game per deployment. State lives in memory:
// a server restart simply returns everyone to the setup screen.
let state = { phase: "setup" };
const clients = new Set(); // open SSE responses

function broadcast(payload) {
  const msg = "data: " + payload + "\n\n";
  for (const res of clients) res.write(msg);
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  // Live event stream — every browser tab subscribes to this.
  if (req.method === "GET" && url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("data: " + JSON.stringify({ state, sender: null }) + "\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  // A player made a move (or started/reset the game).
  if (req.method === "POST" && url === "/state") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy(); // sanity cap
    });
    req.on("end", () => {
      try {
        const msg = JSON.parse(body);
        if (msg && msg.state && typeof msg.state === "object") {
          state = msg.state;
          broadcast(JSON.stringify({ state, sender: msg.sender || null }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
          return;
        }
      } catch {}
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"ok":false}');
    });
    return;
  }

  // Static: the game page.
  if (req.method === "GET" && (url === "/" || url === "/index.html")) {
    fs.readFile(path.join(PUBLIC, "index.html"), (err, data) => {
      if (err) { res.writeHead(500); res.end("error"); return; }
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
