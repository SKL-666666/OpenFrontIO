#!/usr/bin/env node
/**
 * The optional LAN relay: a dumb frame broker for local multiplayer rooms.
 *
 * It runs NO game logic. The simulation is deterministic and runs in every
 * player's own browser (see src/client/local/LocalHub.ts), so the only thing
 * this process does is move JSON frames between the sockets attached to one
 * room code — the BroadcastChannel equivalent for machines that are not the
 * same browser.
 *
 * It also serves the built client from `static/` if one exists, so a host can
 * give friends a URL to open instead of telling them to run a dev server:
 *
 *     npm run build:offline     # once, produces static/
 *     npm run lan               # serves it and relays frames
 *
 * Usage:
 *     node scripts/lan-host.mjs [--port 8790] [--serve PATH] [--no-serve]
 *
 * Defaults to port 8790 on all interfaces, and serves `./static` when it
 * exists. Neither the client nor the room knows this process exists unless a
 * player pastes its `ws://<host>:<port>` address into the room dialog.
 */
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";

// The `ws` dependency is in the project's own dependencies, so this resolves
// without a separate install. `createRequire` rather than a plain import: this
// file is plain ESM and `ws` may be CJS depending on version.
const require = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const args = process.argv.slice(2);
function flag(name, fallback) {
  const at = args.indexOf(`--${name}`);
  if (at !== -1 && at + 1 < args.length) return args[at + 1];
  return fallback;
}
const PORT = Number(flag("port", process.env.LAN_PORT ?? 8790));
const HOST = flag("host", process.env.LAN_HOST ?? "0.0.0.0");
// `--open`: launch a browser once the server is actually listening. Detached,
// because the opener is a launcher rather than a dependency — it must not keep
// this process alive or, on Windows, share a console window with it.
const OPEN_BROWSER = args.includes("--open");
const staticDir = args.includes("--no-serve")
  ? null
  : path.resolve(ROOT, flag("serve", "static"));

const ROOMS = new Map(); // roomCode -> Set<WebSocket>

/** Longest a single frame may be; the relay is a firehose, not a file server. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Static serving (optional)
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".bin": "application/octet-stream",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".webmanifest": "application/manifest+json",
};

/**
 * Resolve a request path inside staticDir, or null when it escapes it.
 *
 * `path.resolve` against a traversal attempt (`../../etc/passwd`) lands outside
 * the root, which the prefix check catches — the same shape vite's own static
 * middleware uses. Windows separators are folded in before the check so a
 * backslash cannot slip past it.
 */
function resolveStatic(pathname) {
  if (staticDir === null || !existsSync(staticDir)) return null;
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  rel = rel.replace(/^\/+/, "").replace(/\\/g, "/");
  if (rel.split("/").some((part) => part === "." || part === "..")) return null;
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  const full = path.join(staticDir, rel);
  if (!full.startsWith(staticDir + path.sep) && full !== staticDir) return null;
  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

/**
 * Extensions worth compressing, and the floor below which gzip costs more
 * CPU than it saves bytes.
 */
const GZIP_MIN_BYTES = 1024;
const COMPRESSIBLE = new Set([
  ".js",
  ".mjs",
  ".css",
  ".html",
  ".json",
  ".map",
  ".svg",
  ".txt",
  ".md",
  ".webmanifest",
]);

/**
 * Cache policy for one built file.
 *
 * Two classes, because the build already tells them apart: Vite's `/assets/`
 * output is content-hashed (`index-BZbHdUie.js`), so the URL changes whenever
 * the content does and the browser can hold it forever. Everything else —
 * index.html, maps, atlases, fonts, images — keeps a stable URL, so it must be
 * revalidated rather than trusted, and is given an ETag so a revalidation that
 * finds no change costs a 304 and zero bytes.
 *
 * Before this, every response was `no-store`: the browser re-downloaded the
 * 2.5 MB bundle, the CSS and every map on every single visit, which is most of
 * what made a repeat load feel slow.
 *
 * The ETag folds in whether the body was gzipped, because a 304 must describe
 * the representation the client already holds — a browser that cached the
 * compressed body must not be told its copy is still valid when the next
 * response would be the uncompressed one. Vary says the same thing for any
 * cache between here and the client.
 *
 * @param {string} pathname the request path, for the /assets/ bucketing
 * @param {string} file the resolved file on disk — compressibility is read
 *   from THIS, not the path: a request for `/` serves `index.html`, whose
 *   extension the request path does not carry.
 * @param {number} size
 * @param {number} mtimeMs
 * @param {string | undefined} acceptEncoding the raw request header
 * @returns {{ headers: Record<string, string>, etag?: string, gzip: boolean }}
 */
function cacheHeaders(pathname, file, size, mtimeMs, acceptEncoding) {
  const ext = path.extname(file).toLowerCase();
  const gzip =
    typeof acceptEncoding === "string" &&
    acceptEncoding.includes("gzip") &&
    COMPRESSIBLE.has(ext) &&
    size >= GZIP_MIN_BYTES;
  const base = `W/"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}"`;

  if (pathname.replace(/\\/g, "/").startsWith("/assets/")) {
    return {
      gzip,
      etag: gzip ? `${base.slice(0, -1)}-gzip"` : base,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        Vary: "Accept-Encoding",
        ...(gzip
          ? { "Content-Encoding": "gzip" }
          : { "Content-Length": String(size) }),
      },
    };
  }
  const etag = gzip ? `${base.slice(0, -1)}-gzip"` : base;
  return {
    gzip,
    etag,
    // Revalidate, but only if changed: maps and atlases are unchanged between
    // visits, so a repeat load should transfer nothing.
    headers: {
      ETag: etag,
      "Cache-Control": "no-cache",
      Vary: "Accept-Encoding",
      ...(gzip
        ? { "Content-Encoding": "gzip" }
        : { "Content-Length": String(size) }),
    },
  };
}

function serveStatic(req, res) {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const file = resolveStatic(pathname) ?? spaFallback(pathname);
  if (file === null) return false;
  const stat = statSync(file);
  const type =
    MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const { headers, etag, gzip } = cacheHeaders(
    pathname,
    file,
    stat.size,
    stat.mtimeMs,
    req.headers["accept-encoding"],
  );
  const ifNoneMatch = req.headers["if-none-match"];
  if (
    etag !== undefined &&
    typeof ifNoneMatch === "string" &&
    ifNoneMatch.split(",").some((v) => v.trim() === etag)
  ) {
    res.writeHead(304, {
      ETag: etag,
      "Cache-Control": headers["Cache-Control"],
      Vary: "Accept-Encoding",
    });
    res.end();
    return true;
  }
  res.writeHead(200, { "Content-Type": type, ...headers });
  const source = createReadStream(file);
  // A gzipped response cannot carry Content-Length, so it is chunked — which
  // still cuts the 2.5 MB bundle to about 660 KB and is the difference between
  // "instant on localhost" and "noticeable over wifi".
  (gzip ? source.pipe(createGzip()) : source).pipe(res);
  return true;
}

/**
 * index.html for a path the build does not actually have a file for.
 *
 * The client routes by path (`/w0/game/<id>?live` is pushed when a game
 * starts, and reloads a room from `#local-room=`), so a static server that
 * answers those with a 404 hands the player a dead page for a game that is
 * running fine. Same rule as Vite's dev server and nginx's SPA fallback: any
 * extensionless GET that resolved to nothing is the app asking to be reloaded.
 *
 * Restricted to extensionless paths so a genuinely missing asset still 404s —
 * that is the answer the client shows its own "file missing" handling for.
 */
function spaFallback(pathname) {
  if (staticDir === null) return null;
  if (pathname.split("/").pop().includes(".")) return null;
  const index = path.join(staticDir, "index.html");
  try {
    return statSync(index).isFile() ? index : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------

function roomOf(url) {
  try {
    const parsed = new URL(url, "http://localhost");
    const room = parsed.searchParams.get("room");
    return room && /^[A-Za-z0-9]{8,10}$/.test(room) ? room : null;
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET" });
    res.end();
    return;
  }
  if (serveStatic(req, res)) return;
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(
    staticDir === null || !existsSync(staticDir)
      ? "LAN relay is up (no client built here). Run: npm run build:offline\n"
      : "Not found\n",
  );
});

let WebSocketServer;
try {
  ({ WebSocketServer } = require("ws"));
} catch (e) {
  console.error(
    "This relay needs the project's own `ws` dependency.\n" +
      "Run `npm run inst` in the repo root first.\n",
    e?.message ?? e,
  );
  process.exit(1);
}

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const room = roomOf(req.url);
  if (room === null) {
    // Refuse rather than accept-and-drop: an unanswered upgrade leaves the
    // client's reconnect backoff as the only signal something is wrong, and
    // "wrong room name" is a much better one.
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.room = room;
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  const room = ws.room;
  let peers = ROOMS.get(room);
  if (peers === undefined) {
    peers = new Set();
    ROOMS.set(room, peers);
  }
  peers.add(ws);
  console.log(`+ ${room} (${peers.size} connected)`);

  ws.on("message", (data, isBinary) => {
    // Frames arrive as JSON text (see LocalHub.createRelayHub); binary is
    // refused so a future change cannot silently turn this into an echo
    // amplifier for large payloads.
    if (isBinary || typeof data !== "string") {
      ws.close(1003, "text-frames-only");
      return;
    }
    if (data.length > MAX_FRAME_BYTES) {
      ws.close(1009, "frame-too-large");
      return;
    }
    for (const peer of peers) {
      if (peer === ws) continue;
      if (peer.readyState === 1) peer.send(data);
    }
  });

  const drop = () => {
    if (!peers.has(ws)) return;
    peers.delete(ws);
    console.log(`- ${room} (${peers.size} connected)`);
    // Empty rooms are dropped so a long-running relay does not accumulate one
    // Set per code ever used.
    if (peers.size === 0) ROOMS.delete(room);
  };
  ws.on("close", drop);
  ws.on("error", drop);
});

function lanAddresses() {
  const nets = require("node:os").networkInterfaces();
  const out = [];
  for (const list of Object.values(nets)) {
    for (const net of list ?? []) {
      if (net.family !== "IPv4" || net.internal) continue;
      out.push(net.address);
    }
  }
  return out;
}

/**
 * Open a URL in the platform's default browser.
 *
 * Runs detached with stdio ignored so the browser is not treated as a child
 * that keeps the terminal attached, and never surfaces errors: a headless box
 * (or one without `xdg-open`) must still serve, not crash because it could not
 * open a window.
 */
function openBrowser(url) {
  const cmd =
    process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };
  try {
    spawn(cmd.file, cmd.args, { detached: true, stdio: "ignore" })
      .on("error", () => {})
      .unref();
  } catch {
    // Nothing useful to do: the server is up, which is what matters.
  }
}

server.listen(PORT, HOST, () => {
  const addresses = lanAddresses();
  console.log("OpenFront LAN relay");
  console.log(`  listen   ${HOST}:${PORT}`);
  console.log(
    `  serve    ${
      staticDir !== null && existsSync(staticDir)
        ? staticDir
        : "(no static/ — run: npm run build:offline)"
    }`,
  );
  for (const address of addresses) {
    console.log(`  LAN URL  http://${address}:${PORT}/`);
    console.log(`  relay    ws://${address}:${PORT}`);
  }
  if (addresses.length === 0) {
    console.log("  LAN URL  (no non-loopback IPv4 interface found)");
  }
  console.log("\nPlayers paste `ws://<host>:<port>` into the room dialog.");
  // Last, so the printed banner is visible behind whatever window pops up and
  // so the browser is only launched from the listening callback — before it,
  // a connect would race the bind.
  if (OPEN_BROWSER) {
    console.log("Opening the browser...");
    openBrowser(`http://localhost:${PORT}/`);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const peers of ROOMS.values()) {
      for (const ws of peers) ws.close(1001, "host-stopped");
    }
    server.close(() => process.exit(0));
    // The close callback may never run while sockets linger; exit on a timer so
    // a Ctrl-C always terminates instead of appearing to hang.
    setTimeout(() => process.exit(0), 500).unref();
  });
}
