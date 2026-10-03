#!/usr/bin/env node
// Kimi Coding live-catalog E2E fixture (YAN-192).
//
// Spins up the real production app under a disposable HOME/DATA_DIR, serves a
// loopback mock relay speaking the x-relay-target / x-relay-path protocol, and
// asserts real dashboard + public model endpoints:
//   success (live list, metadata, caps) -> failure (503, static fallback, no
//   leaked secret) -> refresh recovery.
//
// Run (only after parent gates the integrated backend):
//   node tests/e2e/kimi-live-models.mjs
//   node tests/e2e/kimi-live-models.mjs --serve   # run scenario, then keep alive
//
// No real secrets, no real provider calls. All credentials synthetic.
// Stdlib only. Never touches real HOME / DATA_DIR.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const SERVE = args.includes("--serve");

const SECRET = "kimi-fixture-only-never-real";
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- preconditions (no app launched until these hold) ----
const standalone = path.join(ROOT, ".next", "standalone", "custom-server.js");
if (!fs.existsSync(standalone)) {
  console.error("missing production build: run `npm run build` first (parent-gated).");
  process.exit(2);
}

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ---- disposable state ----
const TMP_ROOT = "/tmp/opencode";
fs.mkdirSync(TMP_ROOT, { recursive: true });
const scratch = fs.mkdtempSync(path.join(TMP_ROOT, "yan-192-e2e-"));
const home = path.join(scratch, "home");
const data = path.join(scratch, "data");
const appdata = path.join(scratch, "appdata");
for (const d of [home, data, appdata]) fs.mkdirSync(d, { recursive: true });
if (!scratch.startsWith(TMP_ROOT) || scratch === TMP_ROOT) {
  console.error("refusing to run: scratch dir not isolated");
  process.exit(2);
}

// ---- mock relay (loopback only, x-relay protocol) ----
let mode = "success";
const counts = { kimi: 0 };
const SUCCESS_BODY = {
  object: "list",
  data: [
    {
      id: "kimi-for-coding",
      display_name: "Fixture Coding Live",
      context_length: 262144,
      supports_reasoning: false,
      supports_image_in: false,
      supports_video_in: false,
    },
    {
      id: "kimi-fixture-next",
      display_name: "Fixture Next",
      context_length: 131072,
      supports_reasoning: true,
      supports_image_in: true,
      supports_video_in: true,
    },
    {
      // Partial: reasoning explicitly false, video true, image flag OMITTED
      // upstream. The API must keep vision absent (no heuristic fill);
      // the dashboard's per-key `{ ...getCaps, ...model.capabilities }`
      // spread falls back to the `*kimi*for-coding*` pattern for that key.
      id: "kimi-for-coding-partial",
      display_name: "Fixture Partial",
      context_length: 65536,
      supports_reasoning: false,
      supports_video_in: true,
    },
  ],
};
const relay = http.createServer((req, res) => {
  const target = req.headers["x-relay-target"];
  const rpath = req.headers["x-relay-path"] || "";
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  if (target === "https://api.kimi.com" && rpath === "/coding/v1/models" && req.method === "GET") {
    counts.kimi++;
    if (req.headers.authorization !== `Bearer ${SECRET}`)
      return send(401, { error: "bad fixture credential" });
    if (!req.headers["x-msh-device-id"])
      return send(400, { error: "missing fixture device header" });
    if (mode === "failure") return send(503, { error: `upstream down ${SECRET}` });
    if (mode === "invalid") return send(200, "not-json{{{", "text/plain");
    return send(200, SUCCESS_BODY);
  }
  if (!target && req.url?.startsWith("/__kimi-fixture/mode") && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        mode = JSON.parse(raw).mode || mode;
      } catch {}
      send(200, { mode });
    });
    return;
  }
  send(404, { error: "fixture relay: unknown target" });
});
await new Promise((r) => relay.listen(0, "127.0.0.1", r));
const relayUrl = `http://127.0.0.1:${relay.address().port}`;

// ---- child preload: reject non-loopback fetch before app imports ----
const preload = path.join(scratch, "egress-guard.mjs");
fs.writeFileSync(
  preload,
  `const orig = globalThis.fetch;
globalThis.fetch = (input, init) => {
  let u = "";
  try {
    if (typeof input === "string") u = input;
    else if (input instanceof URL) u = input.href;
    else if (input && typeof input.url === "string") u = input.url; // Request
    else return Promise.reject(new Error("[e2e-fixture] blocked unparseable fetch destination"));
  } catch {
    return Promise.reject(new Error("[e2e-fixture] blocked unparseable fetch destination"));
  }
  let host = "";
  try { host = new URL(u).hostname; } catch {
    return Promise.reject(new Error("[e2e-fixture] blocked unparseable fetch destination"));
  }
  if (host && host !== "127.0.0.1" && host !== "localhost" && host !== "::1")
    return Promise.reject(new Error("[e2e-fixture] blocked external fetch: " + host));
  return orig(input, init);
};\n`,
);

// ---- app child ----
const port = await freePort();
const PASSWORD = `fx-${randomBytes(8).toString("hex")}`;
const appLog = path.join(scratch, "app.log");
const logFd = fs.openSync(appLog, "a");
let app;
let spawnError;
let resolveChildClosed;
const childClosed = new Promise((resolve) => {
  resolveChildClosed = resolve;
});
let cleanupPromise;
const base = `http://127.0.0.1:${port}`;
const die = (msg) => {
  console.error(`FATAL: ${msg} (app log: ${appLog})`);
  throw new Error(msg);
};
async function childSettledWithin(ms) {
  let timer;
  try {
    return await Promise.race([
      childClosed.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (app) {
      if (app.exitCode === null && app.signalCode === null) {
        app.kill("SIGTERM");
        if (!(await childSettledWithin(10_000))) app.kill("SIGKILL");
      }
      // Never close log/remove state before the child and its pipes close.
      await childClosed;
    }
    relay.closeAllConnections();
    await new Promise((resolve) => relay.close(resolve));
    fs.closeSync(logFd);
    fs.rmSync(scratch, { recursive: true, force: true });
  })();
  return cleanupPromise;
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await cleanup();
    process.exit(130);
  });
}

async function main() {
  app = spawn(
    process.execPath,
    ["--import", preload, "custom-server.js", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: path.join(ROOT, ".next", "standalone"),
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        DATA_DIR: data,
        APPDATA: appdata,
        XDG_CONFIG_HOME: path.join(scratch, "config"),
        XDG_CACHE_HOME: path.join(scratch, "cache"),
        NODE_ENV: "production",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        JWT_SECRET: randomBytes(32).toString("hex"),
        INITIAL_PASSWORD: PASSWORD,
        TOKENHOP_MULTI_USER: "off",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  app.on("error", (error) => {
    spawnError = error;
  });
  app.once("close", resolveChildClosed);
  app.stdout.on("data", (d) => fs.writeSync(logFd, d));
  app.stderr.on("data", (d) => fs.writeSync(logFd, d));

  const readyDeadline = Date.now() + 60_000;
  while (true) {
    if (spawnError) die(`app spawn failed (${spawnError.code || "unknown"})`);
    if (app.exitCode !== null || app.signalCode !== null)
      die(`app exited during startup (code ${app.exitCode}, signal ${app.signalCode})`);
    try {
      if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) break;
    } catch {}
    if (Date.now() >= readyDeadline) die("app did not become ready in 60s");
    await sleep(500);
  }

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  if (!login.ok || !cookie.includes("auth_token")) die(`fixture login failed (${login.status})`);
  const call = async (method, url, body) => {
    const r = await fetch(`${base}${url}`, {
      method,
      headers: { cookie, origin: base, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json, text };
  };

  // ---- scenario: pool + connection + assertions ----
  if (spawnError) die(`app spawn failed (${spawnError.code || "unknown"})`);
  if (app.exitCode !== null || app.signalCode !== null)
    die(`app exited during setup (code ${app.exitCode}, signal ${app.signalCode})`);
  const pool = await call("POST", "/api/proxy-pools", {
    name: "kimi-fixture-pool",
    type: "vercel",
    proxyUrl: relayUrl,
    isActive: true,
    strictProxy: true,
  });
  check(
    "proxy pool created",
    pool.status === 201 && !!pool.json?.proxyPool?.id,
    String(pool.status),
  );
  const poolId = pool.json?.proxyPool?.id;

  const conn = await call("POST", "/api/providers", {
    provider: "kimi",
    apiKey: SECRET,
    name: "kimi-fixture",
    testStatus: "active",
    proxyPoolId: poolId,
    providerSpecificData: { deviceId: "fixture-device" },
  });
  check(
    "kimi connection created",
    conn.status === 201 && !!conn.json?.connection?.id,
    String(conn.status),
  );
  const connId = conn.json?.connection?.id;

  const key = await call("POST", "/api/keys", { name: "kimi-fixture-key" });
  check("gateway API key created", !!key.json?.key?.startsWith("sk-"), String(key.status));
  const apiKey = key.json.key;
  const pubCall = async (url) => {
    const r = await fetch(`${base}${url}`, { headers: { authorization: `Bearer ${apiKey}` } });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json, text };
  };

  const dash = await call("GET", `/api/providers/${connId}/models?hidden=1&refresh=1`);
  const dModels = dash.json?.models ?? [];
  const live = dModels.find((m) => m.id === "kimi-fixture-next");
  const known = dModels.find((m) => m.id === "kimi-for-coding");
  check("dashboard live list has fixture model", !!live);
  const partial = dModels.find((m) => m.id === "kimi-for-coding-partial");
  check("live model context metadata", live?.contextLength === 131072, String(live?.contextLength));
  check(
    "live model capability flags",
    live?.capabilities?.reasoning === true &&
      live?.capabilities?.vision === true &&
      live?.capabilities?.videoInput === true,
    JSON.stringify(live?.capabilities),
  );
  check(
    "explicit false flags preserved on known id",
    !!known &&
      known.capabilities?.reasoning === false &&
      known.capabilities?.vision === false &&
      known.capabilities?.videoInput === false,
    JSON.stringify(known?.capabilities),
  );
  check("dashboard carries no credentials", !dash.text.includes(SECRET));
  check(
    "dashboard success catalog models only",
    dash.status === 200 && Array.isArray(dash.json?.models) && !("warning" in (dash.json ?? {})),
    `${dash.status} ${Object.keys(dash.json ?? {}).sort()}`,
  );
  check(
    "dashboard partial keeps explicit false, omits vision",
    !!partial &&
      partial.capabilities?.reasoning === false &&
      !("vision" in (partial.capabilities ?? {})),
    JSON.stringify(partial?.capabilities),
  );
  check(
    "dashboard partial context metadata",
    partial?.contextLength === 65536,
    String(partial?.contextLength),
  );

  const pub = await pubCall("/v1/models");
  const pubEntries = pub.json?.data ?? [];
  const byId = (id) => pubEntries.find((m) => m.id === `kimi/${id}`);
  const pubNext = byId("kimi-fixture-next");
  const pubKnown = byId("kimi-for-coding");
  const pubPartial = byId("kimi-for-coding-partial");
  check(
    "public HTTP 200 OpenAI list",
    pub.status === 200 && pub.json?.object === "list",
    String(pub.status),
  );
  check(
    "public exact live ids",
    !!pubNext && !!pubKnown && !!pubPartial,
    JSON.stringify(pubEntries.filter((m) => String(m.id).startsWith("kimi/")).map((m) => m.id)),
  );
  check("public next context window", pubNext?.context_length === 131072, JSON.stringify(pubNext));
  check(
    "public next capabilities true",
    pubNext?.capabilities?.reasoning === true &&
      pubNext?.capabilities?.vision === true &&
      pubNext?.capabilities?.videoInput === true,
    JSON.stringify(pubNext?.capabilities),
  );
  check(
    "public known explicit false flags",
    pubKnown?.capabilities?.reasoning === false &&
      pubKnown?.capabilities?.vision === false &&
      pubKnown?.capabilities?.videoInput === false,
    JSON.stringify(pubKnown?.capabilities),
  );
  check(
    "public partial entry keeps own context",
    pubPartial?.context_length === 65536,
    JSON.stringify(pubPartial),
  );
  check(
    "public partial omitted vision stays absent",
    pubPartial?.capabilities != null && !("vision" in pubPartial.capabilities),
    JSON.stringify(pubPartial?.capabilities),
  );
  check(
    "public entries carry no warnings",
    pubEntries.every((m) => m?.warning === undefined),
  );
  check("public envelope has no warning field", pub.json?.warning === undefined);
  check("public carries no credentials", !pub.text.includes(SECRET));

  const before = counts.kimi;
  await call("GET", `/api/providers/${connId}/models?hidden=1`);
  check(
    "repeat without refresh reuses cache",
    counts.kimi === before,
    `kimi fetches=${counts.kimi}`,
  );

  // failure: switch relay to 503 (server-side), force refresh
  await fetch(`${relayUrl}/__kimi-fixture/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "failure" }),
  });
  const fail = await call("GET", `/api/providers/${connId}/models?hidden=1&refresh=1`);
  check("failure keeps HTTP 200 with warning", fail.status === 200 && !!fail.json?.warning);
  check(
    "failure dashboard returns empty models",
    fail.status === 200 && Array.isArray(fail.json?.models) && fail.json.models.length === 0,
    JSON.stringify(fail.json?.models),
  );
  check("failure warning sanitized", !String(fail.json?.warning ?? "").includes(SECRET));
  const pubFail = await pubCall("/v1/models");
  const pubFailIds = (pubFail.json?.data ?? []).map((m) => m.id);
  check(
    "public falls back to static catalog on failure",
    pubFail.status === 200 &&
      pubFail.json?.object === "list" &&
      pubFail.json?.warning === undefined &&
      (pubFail.json?.data ?? []).every((m) => m.warning === undefined) &&
      pubFailIds.includes("kimi/kimi-k2.6"),
    JSON.stringify(pubFailIds.slice(0, 5)),
  );

  // recovery
  await fetch(`${relayUrl}/__kimi-fixture/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "success" }),
  });
  const rec = await call("GET", `/api/providers/${connId}/models?hidden=1&refresh=1`);
  check(
    "recovery restores live list",
    (rec.json?.models ?? []).some((m) => m.id === "kimi-fixture-next"),
  );

  console.log(`\nrelay kimi fetches: ${counts.kimi}`);
  console.log(failures ? `${failures} FAILED` : "ALL PASSED");

  // --serve never opens on a failed scenario; it also returns so finally can
  // always clean up (a hanging serve would otherwise skip cleanup on !SERVE).
  if (failures) {
    process.exitCode = 1;
    return;
  }
  if (SERVE) {
    console.log(`app:     ${base}/dashboard/providers/kimi`);
    console.log(
      `control: POST ${relayUrl}/__kimi-fixture/mode  {"mode":"success|failure|invalid"}`,
    );
    console.log(`login password (fixture-only): ${PASSWORD}`);
    console.log("fixture kept alive for browser checks; SIGINT to clean up.");
    await new Promise(() => {});
  }
}

try {
  await main();
} finally {
  await cleanup();
}
