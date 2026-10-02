const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Repo checkout and Docker keep the brand module beside this file; the CLI package
// ships custom-server.js in app/ and its packed copy one level up.
const BRAND_MODULE = path.join(__dirname, "src", "shared", "brand", "index.cjs");
const { readEnv } = require(
  fs.existsSync(BRAND_MODULE)
    ? BRAND_MODULE
    : path.join(__dirname, "..", "src", "shared", "brand", "index.cjs"),
);

function loadOAuthClientDefaults(file, env = process.env) {
  if (!fs.existsSync(file)) return [];

  let defaults;
  try {
    defaults = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse OAuth client defaults at ${file}: ${error.message}`, {
      cause: error,
    });
  }
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw new Error(`OAuth client defaults at ${file} must be a JSON object`);
  }

  // Each group is applied atomically: env wins if any key in the group is set,
  // built-ins apply only when every key in the group is present.
  const applied = [];
  for (const keys of [
    ["GEMINI_OAUTH_CLIENT_ID", "GEMINI_OAUTH_CLIENT_SECRET"],
    ["ANTIGRAVITY_OAUTH_CLIENT_ID", "ANTIGRAVITY_OAUTH_CLIENT_SECRET"],
    ["META_CODE_OAUTH_CLIENT_ID"],
  ]) {
    const hasEnvValue = keys.some((key) => String(env[key] ?? "").trim());
    const hasDefaults = keys.every(
      (key) => typeof defaults[key] === "string" && defaults[key].trim(),
    );
    if (!hasEnvValue && hasDefaults) {
      for (const key of keys) env[key] = defaults[key];
      applied.push(...keys);
    }
  }
  return applied;
}

module.exports = { loadOAuthClientDefaults };

// Generated only in published Docker images / npm package (see scripts/write-oauth-clients.cjs).
// Precedence: env > built-in > unset.
loadOAuthClientDefaults(path.join(__dirname, "oauth-clients.json"));

const origCreate = http.createServer.bind(http);

// Per-process secret proving x-9r-real-ip was stamped below rather than sent by the client.
// A bare `next start` / `next dev` never loads this file, so it cannot produce a matching
// header even though the env var is inherited by child processes. Named like x-9r-cli-token
// so the request-detail header sanitizer redacts it too.
const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
process.env.TOKENHOP_PEER_TOKEN = PEER_TOKEN;

// Same limit Next applies to normal requests (next.config.mjs proxyClientMaxBodySize), so the
// h2c path below cannot buffer an unbounded body before auth runs.
const DEFAULT_MAX_BODY_BYTES = 128 * 1024 * 1024;
function parseBodySizeLimit(value) {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i.exec(String(value || "").trim());
  if (!match) return DEFAULT_MAX_BODY_BYTES;
  const unit = { b: 0, kb: 1, mb: 2, gb: 3, tb: 4 }[(match[2] || "b").toLowerCase()];
  const bytes = Math.floor(Number(match[1]) * 1024 ** unit);
  return Number.isSafeInteger(bytes) ? bytes : DEFAULT_MAX_BODY_BYTES;
}
const MAX_H2C_BODY_BYTES = parseBodySizeLimit(readEnv("PROXY_CLIENT_MAX_BODY_SIZE"));

function rightmostForwardedIp(xff) {
  if (!xff) return "";
  const hops = String(xff)
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops[hops.length - 1] || "";
}

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy =
      socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    // Take the rightmost XFF hop: appending proxies (Cloudflare edge via cloudflared,
    // nginx $proxy_add_x_forwarded_for) add the real peer last, while every entry to
    // its left is client-supplied and rotatable.
    const proxyIp = rightmostForwardedIp(xff) || xRealIp || "";
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    delete req.headers["x-9r-peer-token"];
    req.headers["x-9r-real-ip"] = ip;
    req.headers["x-9r-peer-token"] = PEER_TOKEN;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  const server = origCreate(...rest, wrapped);
  const origEmit = server.emit;
  // JBR 25 sends h2c upgrades that the HTTP/1.1 server would otherwise close.
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      socket.destroy();
      return true;
    }
    if (contentLength > MAX_H2C_BODY_BYTES) {
      socket.end(
        "HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return true;
    }
    const chunks = [head];
    let received = head.length;
    const serve = () => {
      // Replay the upgraded request through the existing HTTP/1.1 handler.
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, {
        method: req.method,
        url: req.url,
        headers: req.headers,
        complete: true,
      });
      if (received) replay.push(Buffer.concat(chunks, received).subarray(0, contentLength));
      replay.push(null);
      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      res.once("finish", () => socket.end());
      Promise.resolve()
        .then(() => wrapped(replay, res))
        .catch((error) => {
          console.error("Failed to downgrade h2c request", error);
          socket.destroy();
        });
    };
    if (received >= contentLength) serve();
    else {
      socket.on("data", function readBody(chunk) {
        chunks.push(chunk);
        received += chunk.length;
        if (received < contentLength) return;
        socket.off("data", readBody);
        serve();
      });
      socket.resume();
    }
    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

if (require.main === module) {
  const standalone = path.join(__dirname, "server.js");
  if (fs.existsSync(standalone)) {
    require(standalone);
  } else {
    // Repo checkout has no standalone build next to us. `next start` builds its HTTP
    // server in-process, so the wrapper above still sanitizes every request.
    const nextBin = require.resolve("next/dist/bin/next");
    process.argv = [process.argv[0], nextBin, "start", ...process.argv.slice(2)];
    require(nextBin);
  }
}
