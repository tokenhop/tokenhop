#!/usr/bin/env node
// End-to-end upgrade verification (YAN-344): real state written by the last
// 9router release, then the tokenhop build of this checkout started on it.
//
// Prerequisites (the script never builds anything itself):
//   git worktree add --detach /tmp/9router-old v0.6.1      # last stable 9router tag
//   (cd /tmp/9router-old && npm ci && npm run build)
//   npm ci && NEXT_PUBLIC_BRAND=tokenhop npm run build      # this checkout
//   docker build --build-arg NEXT_PUBLIC_BRAND=tokenhop -t tokenhop:e2e-upgrade .
//     (add --build-arg APK_MIRROR=dl-cdn.alpinelinux.org --build-arg
//      NPM_REGISTRY=https://registry.npmjs.org outside CN)
//   Docker Compose v2.24+ (the override uses !override / !reset).
//
// Run:
//   node tests/e2e/upgrade-from-9router.mjs --old /tmp/9router-old [--skip-docker]
//     [--new-image tokenhop:e2e-upgrade]
//
// 1. Old state (9router, throwaway HOME): data dir with a DB, an API key, a
//    combo and a provider connection; SAML saved without an issuer; tool configs
//    applied through the old API (Codex, OpenCode, OpenClaw, Droid, Grok Build,
//    jcode); legacy env vars; an exported backup; Linux autostart; a MITM CA.
// 2. Swap to the tokenhop build of this checkout on the same HOME.
// 3. Assert: data, keys and SAML issuer unchanged; every tool shows as
//    configured and a re-apply migrates it to tokenhop keeping its model; each
//    legacy env var honoured with exactly one warning; the backup imports;
//    autostart migrates; the CA fingerprint is unchanged; `tokenhop data
//    migrate` succeeds, a second run says "already migrated", and a restart
//    after migrating still shows the data.
// 4. Docker: the old image writes to a throwaway volume, then the repo's
//    compose.yml (pointed at that volume) starts tokenhop on it.
//
// Everything runs under a throwaway HOME and throwaway Docker volumes/containers
// (prefix th344-), removed on exit. It never touches the real ~/.9router,
// ~/.tokenhop, tool configs or existing volumes. Not part of `npm test`.
//
// Manual checks, not automated here:
//   - macOS launchd / Windows Startup autostart (Linux .desktop is covered);
//   - installing the MITM CA into an OS trust store (only the CA file is checked);
//   - the legacy `9router.pid` launcher hand-over (covered by the CLI unit tests
//     and the YAN-615 verification; it needs the packed CLI and a tray).

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const OLD = opt("--old");
const NEW_IMAGE = opt("--new-image", "tokenhop:e2e-upgrade");
const SKIP_DOCKER = args.includes("--skip-docker");
if (!OLD) {
  console.error("usage: upgrade-from-9router.mjs --old <9router checkout> [--skip-docker]");
  process.exit(2);
}
const OLD_TAG = spawnSync("git", ["-C", OLD, "describe", "--tags", "--exact-match"], {
  encoding: "utf8",
}).stdout.trim();

// ---------------------------------------------------------------- harness
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const step = (title) => console.log(`\n== ${title}`);
const cleanups = [];
const cleanup = () => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {}
  }
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "th344-home-"));
cleanups.push(() => fs.rmSync(HOME, { recursive: true, force: true }));
const JWT = randomBytes(32).toString("hex");
const PASSWORD = "e2e-password";
// Legacy env names the server reads (UPGRADING.md §3).
const LEGACY_ENV = {
  NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE: "64mb",
  NINE_ROUTER_DISABLE_MITM: "1",
};

const servers = {};
/** Start a standalone build under HOME; returns { base, logs(), stop() }. */
async function startServer(dir, label, extraEnv = {}) {
  const port = await freePort();
  const out = [];
  const child = spawn(process.execPath, ["custom-server.js", "--port", String(port)], {
    cwd: path.join(dir, ".next", "standalone"),
    env: {
      PATH: process.env.PATH,
      HOME,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      JWT_SECRET: JWT,
      INITIAL_PASSWORD: PASSWORD,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));
  const stop = () => {
    if (child.exitCode === null) child.kill("SIGTERM");
  };
  cleanups.push(stop);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    await sleep(500);
  }
  check(`${label} server is up`, (await fetch(`${base}/api/health`).catch(() => ({}))).ok === true);
  servers[label.replace(/\W+/g, "-")] = { logs: () => out.join("") };
  return {
    base,
    logs: () => out.join(""),
    stop: async () => {
      stop();
      for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(250);
    },
  };
}

/** Logged-in JSON client for one server. */
async function client(base) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const call = async (method, url, body, headers = {}) => {
    const r = await fetch(`${base}${url}`, {
      method,
      headers: {
        cookie,
        origin: base,
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json, text };
  };
  return { loggedIn: res.ok && cookie.includes("auth_token"), call };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const TOOLS = [
  // [route, file under HOME, legacy marker written by 9router, new marker]
  ["codex", ".codex/config.toml", "[model_providers.9router]", "[model_providers.tokenhop]"],
  ["opencode", ".config/opencode/opencode.json", '"9router"', '"tokenhop"'],
  ["openclaw", ".openclaw/openclaw.json", '"9router"', '"tokenhop"'],
  ["droid", ".factory/settings.json", "custom:9Router-", "custom:tokenhop-"],
  ["grok-build", ".grok/config.toml", "9router", "tokenhop"],
  ["jcode", ".jcode/config.toml", "[providers.9router]", "[providers.tokenhop]"],
];
const MODEL = "e2e-combo";
const toolBody = (tool, base, key) =>
  tool === "jcode"
    ? { baseUrl: `${base}/v1`, apiKey: key, models: [MODEL] }
    : { baseUrl: `${base}/v1`, apiKey: key, model: MODEL };

// ---------------------------------------------------------------- 1. old state
step(`1. Old state with 9router ${OLD_TAG || "(untagged)"} under ${HOME}`);
check("old checkout is a stable release tag", /^v0\.\d+\.\d+$/.test(OLD_TAG), OLD_TAG);
const legacyDir = path.join(HOME, ".9router");
const old = await startServer(OLD, "9router", LEGACY_ENV);
const oc = await client(old.base);
check("login to 9router", oc.loggedIn);

const key = (await oc.call("POST", "/api/keys", { name: "e2e" })).json?.key;
check("API key created", typeof key === "string" && key.startsWith("sk-"));
const conn = await oc.call("POST", "/api/providers", {
  provider: "openai",
  apiKey: "sk-dummy-e2e",
  name: "e2e-openai",
});
check(
  "provider connection created",
  conn.status === 201 || conn.status === 200,
  String(conn.status),
);
const combo = await oc.call("POST", "/api/combos", {
  name: MODEL,
  models: ["openai/gpt-4o-mini", "openai/gpt-4o"],
});
check("combo created", !!combo.json?.id);
const saml = await oc.call("PATCH", "/api/settings", {
  samlEntryPoint: "https://idp.example.com/sso",
  samlCert: "MIIC123456789012345678901234567890123456789012345678901234567890",
});
check("SAML saved without an issuer", saml.status === 200);
const oldIssuer = saml.json?.samlIssuer;
for (const [tool, file, legacy] of TOOLS) {
  const r = await oc.call("POST", `/api/cli-tools/${tool}-settings`, toolBody(tool, old.base, key));
  check(`${tool}: applied by 9router`, r.json?.success === true, r.json?.error);
  check(`${tool}: config carries the 9router entry`, read(path.join(HOME, file)).includes(legacy));
}
const backup = (await oc.call("GET", "/api/settings/database", null, { "x-9r-password": PASSWORD }))
  .json;
check("backup exported", !!backup?.apiKeys?.length && !!backup?.combos?.length);
await old.stop();

// NINE_ROUTER_DISABLE_MITM is only read when MITM was on (the launcher sets it
// after repeated MITM crashes), so record MITM as enabled, as such a run would.
{
  const db = new DatabaseSync(path.join(legacyDir, "db", "data.sqlite"));
  const row = db.prepare("SELECT data FROM settings WHERE id = 1").get();
  db.prepare("UPDATE settings SET data = ? WHERE id = 1").run(
    JSON.stringify({ ...JSON.parse(row.data), mitmEnabled: true }),
  );
  db.close();
}

// Host-side state with the old release's own code.
const oldNode = (code) =>
  spawnSync(process.execPath, ["-e", code], {
    cwd: OLD,
    env: { PATH: process.env.PATH, HOME, DISPLAY: ":99" },
    encoding: "utf8",
  });
oldNode('require("./src/mitm/cert/rootCA.js").generateRootCA()');
const caFile = path.join(legacyDir, "mitm", "rootCA.crt");
check("MITM CA generated (not installed)", fs.existsSync(caFile));
const caFingerprint = fs.existsSync(caFile) ? new X509Certificate(read(caFile)).fingerprint256 : "";
const autostartDir = path.join(HOME, ".config", "autostart");
const enabled = oldNode(
  `const a=require("./cli/src/cli/tray/autostart.js");process.stdout.write(String(a.enableAutoStart(${JSON.stringify(path.join(OLD, "cli", "cli.js"))},{port:20128})))`,
).stdout;
check(
  "Linux autostart enabled by 9router",
  enabled === "true" && fs.existsSync(path.join(autostartDir, "9router.desktop")),
);

// ---------------------------------------------------------------- 2-3. tokenhop on the same HOME
step("2. Swap to the tokenhop build of this checkout");
// Next.js inlines NEXT_PUBLIC_BRAND into the client bundles at build time.
const layoutChunks = fs
  .readdirSync(path.join(ROOT, ".next", "static", "chunks", "app"))
  .filter((f) => f.startsWith("layout-"));
check(
  "this checkout was built for the tokenhop brand",
  layoutChunks.some((f) =>
    read(path.join(ROOT, ".next", "static", "chunks", "app", f)).includes('="tokenhop")'),
  ),
);
const neu = await startServer(ROOT, "tokenhop", { NEXT_PUBLIC_BRAND: "tokenhop", ...LEGACY_ENV });
const nc = await client(neu.base);
check("login to tokenhop with the old password", nc.loggedIn);
// initializeApp (MITM, tunnels, env-driven settings) runs when the root layout
// first renders on the server (login/dashboard are prerendered, so use a dynamic
// page) and defers its startup work by a few seconds; wait for it.
await nc.call("GET", "/dashboard/providers");
for (let i = 0; i < 40 && !/\[InitApp\] MITM disabled by launcher/.test(neu.logs()); i++)
  await sleep(500);

step("3. Assertions");
check(
  "legacy ~/.9router is used (no ~/.tokenhop created)",
  !fs.existsSync(path.join(HOME, ".tokenhop")),
);
check("legacy data dir notice logged", /\[DATA_DIR\] using legacy .*\.9router/.test(neu.logs()));
const keys = (await nc.call("GET", "/api/keys")).json?.keys || [];
check(
  "API key still listed",
  keys.some((k) => k.key === key),
);
const models = await fetch(`${neu.base}/v1/models`, {
  headers: { authorization: `Bearer ${key}` },
});
check("API key still authorizes /v1/models", models.ok);
const combos = (await nc.call("GET", "/api/combos")).json;
check("combo still present", JSON.stringify(combos).includes(MODEL));
const conns = (await nc.call("GET", "/api/providers")).json;
check("provider connection still present", JSON.stringify(conns).includes("e2e-openai"));
const settings = (await nc.call("GET", "/api/settings")).json;
check("NINE_ROUTER_DISABLE_MITM took effect (MITM turned off)", settings?.mitmEnabled === false);
check(
  "SAML issuer unchanged",
  settings?.samlIssuer === oldIssuer && oldIssuer === "urn:9router:sp",
  settings?.samlIssuer,
);

for (const [tool, file, legacy, current] of TOOLS) {
  const status = (await nc.call("GET", `/api/cli-tools/${tool}-settings`)).json;
  check(`${tool}: shows as configured`, status?.hasTokenhop === true);
  const r = await nc.call("POST", `/api/cli-tools/${tool}-settings`, toolBody(tool, neu.base, key));
  const text = read(path.join(HOME, file));
  check(`${tool}: re-apply succeeds`, r.json?.success === true, r.json?.error);
  check(`${tool}: migrated to tokenhop`, text.includes(current) && !text.includes(legacy));
  check(`${tool}: keeps its model`, text.includes(MODEL));
}

for (const name of Object.keys(LEGACY_ENV)) {
  const count = neu.logs().split(`deprecated env var "${name}"`).length - 1;
  check(`${name} honoured with exactly one warning`, count === 1, `${count} warnings`);
}

const imported = await nc.call("POST", "/api/settings/database", { password: PASSWORD, ...backup });
check("legacy backup imports", imported.json?.success === true, imported.json?.error);
check(
  "key valid after import",
  (await fetch(`${neu.base}/v1/models`, { headers: { authorization: `Bearer ${key}` } })).ok,
);

check(
  "CA fingerprint unchanged",
  new X509Certificate(read(caFile)).fingerprint256 === caFingerprint,
);
await neu.stop();
const dbAfterServer = sha256(path.join(legacyDir, "db", "data.sqlite"));

// Autostart migrates on the enabled check (tray start); run the new CLI code.
const migrated = spawnSync(
  process.execPath,
  [
    "-e",
    'process.stdout.write(String(require("./cli/src/cli/tray/autostart.js").isAutoStartEnabled()))',
  ],
  {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME, DISPLAY: ":99", NEXT_PUBLIC_BRAND: "tokenhop" },
    encoding: "utf8",
  },
).stdout;
check(
  "autostart migrated to tokenhop.desktop",
  migrated === "true" &&
    fs.existsSync(path.join(autostartDir, "tokenhop.desktop")) &&
    !fs.existsSync(path.join(autostartDir, "9router.desktop")),
);

const cli = (...a) =>
  spawnSync(process.execPath, [path.join(ROOT, "cli", "cli.js"), ...a], {
    env: { PATH: process.env.PATH, HOME, NEXT_PUBLIC_BRAND: "tokenhop" },
    encoding: "utf8",
  });
const m1 = cli("data", "migrate");
check(
  "tokenhop data migrate succeeds",
  m1.status === 0 && fs.existsSync(path.join(HOME, ".tokenhop", "db", "data.sqlite")),
  m1.stdout.trim() || m1.stderr.trim(),
);
const m2 = cli("data", "migrate");
check(
  "second migrate reports already migrated",
  m2.status === 0 && /already migrated/.test(m2.stdout),
  m2.stdout.trim(),
);
// Same filesystem: migrate is a rename, so the database must be byte-identical
// to what the tokenhop server left in the legacy dir before migrating.
check(
  "database moved intact",
  sha256(path.join(HOME, ".tokenhop", "db", "data.sqlite")) === dbAfterServer,
);
const again = await startServer(ROOT, "tokenhop (after migrate)", {
  NEXT_PUBLIC_BRAND: "tokenhop",
});
const ac = await client(again.base);
check(
  "restart after migrating still shows the data",
  JSON.stringify((await ac.call("GET", "/api/combos")).json).includes(MODEL),
);
check("no legacy notice after migrating", !/\[DATA_DIR\] using legacy/.test(again.logs()));
await again.stop();

// ---------------------------------------------------------------- 4. Docker
if (SKIP_DOCKER) {
  console.log("\n(Docker leg skipped)");
} else {
  step("4. Docker: old image, then this compose file, on the same volume");
  const docker = (...a) => spawnSync("docker", a, { encoding: "utf8" });
  const tag = `th344-${randomBytes(3).toString("hex")}`;
  const vol = `${tag}-data`;
  // Cleanups run in reverse: containers go before the volume they use.
  cleanups.push(() => docker("volume", "rm", "-f", vol));
  cleanups.push(() => docker("rm", "-f", `${tag}-old`, `${tag}-new`));
  docker("volume", "create", vol);
  const runImage = async (name, image) => {
    const port = await freePort();
    const r = docker(
      "run",
      "-d",
      "--name",
      name,
      "-p",
      `127.0.0.1:${port}:20128`,
      "-v",
      `${vol}:/app/data`,
      "-e",
      `JWT_SECRET=${JWT}`,
      "-e",
      `INITIAL_PASSWORD=${PASSWORD}`,
      image,
    );
    check(`${name} started (${image})`, r.status === 0, r.stderr.trim());
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {}
      await sleep(500);
    }
    return base;
  };
  const oldImage = `ghcr.io/tokenhop/tokenhop:${OLD_TAG.replace(/^v/, "")}`;
  const ob = await runImage(`${tag}-old`, oldImage);
  const odc = await client(ob);
  const dkey = (await odc.call("POST", "/api/keys", { name: "docker-e2e" })).json?.key;
  check("old image: data written to the volume", typeof dkey === "string");
  docker("rm", "-f", `${tag}-old`);

  const cv = /v?(\d+)\.(\d+)/.exec(docker("compose", "version", "--short").stdout || "");
  check(
    "Docker Compose v2.24+ (override tags)",
    !!cv && (+cv[1] > 2 || (+cv[1] === 2 && +cv[2] >= 24)),
    cv?.[0],
  );
  // The repo's compose.yml, unchanged except for what keeps the run throwaway:
  // the pinned volume name points at this run's volume, the published port is
  // random, the image is the local tokenhop build and the headroom sidecar is off.
  const composeText = read(path.join(ROOT, "compose.yml"));
  check(
    "compose.yml keeps the legacy 9router-data volume name",
    /name:\s*9router-data/.test(composeText),
  );
  const port = await freePort();
  const envFile = path.join(HOME, "compose.env");
  fs.writeFileSync(envFile, `JWT_SECRET=${JWT}\nINITIAL_PASSWORD=${PASSWORD}\n`);
  const override = path.join(HOME, "compose.override.yml");
  fs.writeFileSync(
    override,
    [
      "services:",
      "  tokenhop:",
      `    image: ${NEW_IMAGE}`,
      `    container_name: ${tag}-new`,
      "    ports: !override",
      `      - "127.0.0.1:${port}:20128"`,
      "    env_file: !override",
      `      - ${envFile}`,
      "    depends_on: !reset []",
      "  headroom: !reset null",
      "volumes:",
      "  tokenhop-data:",
      `    name: ${vol}`,
      "",
    ].join("\n"),
  );
  const compose = (...a) =>
    spawnSync(
      "docker",
      ["compose", "-p", tag, "-f", path.join(ROOT, "compose.yml"), "-f", override, ...a],
      {
        encoding: "utf8",
        env: { ...process.env, HOME },
      },
    );
  cleanups.push(() => compose("down"));
  const up = compose("up", "-d", "--no-build", "tokenhop");
  check(
    "compose.yml started the tokenhop service on the old volume",
    up.status === 0,
    up.stderr.trim().split("\n").pop(),
  );
  const nb = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${nb}/api/health`)).ok) break;
    } catch {}
    await sleep(500);
  }
  const ndc = await client(nb);
  check(
    "compose: the old volume's data is present",
    JSON.stringify((await ndc.call("GET", "/api/keys")).json).includes(dkey),
  );
}

console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"}`);
if (failures && process.env.E2E_LOG_DIR) {
  fs.mkdirSync(process.env.E2E_LOG_DIR, { recursive: true });
  for (const [name, srv] of Object.entries(servers)) {
    fs.writeFileSync(path.join(process.env.E2E_LOG_DIR, `${name}.log`), srv.logs());
  }
}
process.exitCode = failures ? 1 : 0;
