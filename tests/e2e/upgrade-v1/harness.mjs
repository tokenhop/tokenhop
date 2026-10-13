// YAN-378 rehearsal harness: yan378- prefixed containers on host networking,
// scratch dir under /tmp/opencode, in-container CLI and sqlite helpers.
// Cleanup removes only names created here; nothing is pruned or discovered.
// Nodes bind 127.0.0.1; asserted loopback-only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { docker, dockerQuiet, freePort, MASTER, PASSWORD, ROOT, secrets, sleep } from "./core.mjs";
import { startIdp, startUpstream } from "./mocks.mjs";

// Runs INSIDE the gateway container, as the same `node` user the entrypoint's
// su-exec drops to: the server runs uid 1000, so /proc/<pid>/fd is mode 0500
// owner-only — a root `docker exec` gets EACCES on every readlink and the
// "owned" walk silently finds nothing (the false "foreign listener").
// With --network host, /proc/net is the shared host table, so ownership is
// proven by the inode walk (same user), not by the port existing.
export const LISTEN_PROBE = `const fs=require('fs');const port=Number(process.argv[1]);const hex=port.toString(16).toUpperCase().padStart(4,'0');let inode=null,local='';for(const f of ['/proc/net/tcp','/proc/net/tcp6']){for(const l of fs.readFileSync(f,'utf8').split('\\n').slice(1)){const c=l.trim().split(/\\s+/);if(c[3]==='0A'&&c[1].endsWith(':'+hex)){inode=c[9];local=c[1];}}}let owned=false,owner=null;if(inode){for(const p of fs.readdirSync('/proc').filter(n=>/^\\d+$/.test(n))){try{for(const fd of fs.readdirSync('/proc/'+p+'/fd')){if(fs.readlinkSync('/proc/'+p+'/fd/'+fd)==='socket:['+inode+']'){owned=true;owner=p;break;}}}catch{}}}console.log(JSON.stringify({owned,owner,local,loopback:/^(0100007F|0000000000000000FFFF00000100007F|00000000000000000000000001000000):/.test(local)}));`;
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const TRANSIENT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * A server that is still booting refuses, resets or stalls connections. Those
 * (and our own per-try abort/timeout) are retried; anything else (DNS, EACCES,
 * TLS, programming errors) is a real failure and must surface immediately.
 */
export function isTransientStartupError(err) {
  if (err?.name === "AbortError" || err?.name === "TimeoutError") return true;
  const code = err?.cause?.code ?? err?.code;
  if (code) return TRANSIENT_CODES.has(code);
  return false; // Unknown failures are not presumed transient.
}

/**
 * Poll `${base}/api/health` until it answers ok, or `deadlineMs` passes.
 * `tick` runs after every unhealthy attempt and may throw (e.g. the container
 * exited), which ends the wait at once. Time and sleeping are injectable.
 */
export async function waitForHealth(
  base,
  {
    fetchFn = fetch,
    deadlineMs = 120_000,
    perTryMs = 2000,
    intervalMs = 500,
    now = Date.now,
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    tick = async () => {},
  } = {},
) {
  const start = now();
  let attempts = 0;
  let last = "no attempt";
  while (now() - start < deadlineMs) {
    attempts++;
    try {
      const res = await fetchFn(`${base}/api/health`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(perTryMs, deadlineMs - (now() - start)))),
      });
      if (res.ok) return { attempts, elapsedMs: now() - start };
      last = `HTTP ${res.status}`;
    } catch (err) {
      if (!isTransientStartupError(err)) {
        throw new Error(`health fetch failed (non-transient ${err?.name}): ${err?.message}`);
      }
      last = `${err?.name}: ${err?.cause?.code ?? err?.code ?? err?.message}`;
    }
    await tick();
    await sleepFn(Math.max(0, Math.min(intervalMs, deadlineMs - (now() - start))));
  }
  throw new Error(`health timeout after ${deadlineMs}ms, ${attempts} attempts (last: ${last})`);
}

/**
 * Container logs are evidence for failures but must not leak fixture secrets,
 * tokens or the run's JWT secret. Redaction is applied before anything prints.
 */
export function sanitizeLogs(text, secretValues = []) {
  let out = String(text ?? "");
  for (const value of secretValues.filter((v) => typeof v === "string" && v.length >= 6))
    out = out.split(value).join("[REDACTED]");
  return out
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(
      /\b(password|secret|token|api[-_]?key)(["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi,
      "$1$2[REDACTED]",
    );
}

export function failedClosed(result) {
  return (
    result.exited === true &&
    result.exitCode !== 0 &&
    !result.listening &&
    result.loginStatus == null &&
    result.healthStatus == null
  );
}

export async function harness() {
  fs.mkdirSync("/tmp/opencode", { recursive: true });
  const scratch = fs.mkdtempSync("/tmp/opencode/yan378-");
  const prefix = `yan378-${randomBytes(4).toString("hex")}`;
  const names = new Set();
  const servers = [];
  let cleaned = false;
  const rmContainer = (name) => dockerQuiet("rm", "-f", name);
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    // Exact names created here only. Never prune, discover or delete others.
    for (const name of names) rmContainer(name);
    for (const server of servers) {
      try {
        server.closeAllConnections();
        server.close();
      } catch {}
    }
    // Anything left by this run's exact label (e.g. a crashed helper).
    const leftovers = spawnSync("docker", ["ps", "-aq", "--filter", `label=yan378-run=${prefix}`], {
      encoding: "utf8",
    });
    for (const id of (leftovers.stdout || "").split("\n").filter(Boolean)) rmContainer(id);
    // Containers chown bind mounts; use image to remove only this scratch tree.
    const cleaner = `${prefix}-cleanup`;
    if (!names.has(cleaner)) {
      names.add(cleaner);
      dockerQuiet(
        "run",
        "--rm",
        "--label",
        `yan378-run=${prefix}`,
        "--name",
        cleaner,
        "--network",
        "none",
        "--entrypoint",
        "sh",
        "-v",
        `${scratch}:/scratch`,
        MASTER,
        "-c",
        "rm -rf /scratch/*",
      );
      rmContainer(cleaner);
    }
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {}
  };
  process.once("exit", cleanup);
  for (const sig of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    process.once(sig, () => {
      try {
        cleanup();
      } finally {
        process.kill(process.pid, sig);
      }
    });
  }
  const listen = async (handler) => {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { address, port } = server.address();
    assert(address === "127.0.0.1" || address === "::ffff:127.0.0.1", "bind must be loopback");
    return `http://127.0.0.1:${port}`;
  };
  const up = await startUpstream(listen);
  const idpMock = await startIdp(listen);
  let serial = 0;
  // passwordEnv null sends an explicitly EMPTY value (never a passthrough of
  // the host env), proving the stored hash authenticates alone.
  const start = async (image, data, mode = "off", passwordEnv = PASSWORD) => {
    // Resolve a tag once, then run that immutable image ID (no tag TOCTOU).
    image = docker("image", "inspect", "--format", "{{.Id}}", image);
    fs.mkdirSync(data, { recursive: true });
    const port = await freePort();
    const name = `${prefix}-${++serial}`;
    names.add(name);
    // Host networking required for strictly-loopback mocks. No network/volume
    // objects created. HOSTNAME binds gateway itself only to loopback.
    docker(
      "run",
      "-d",
      "--name",
      name,
      "--label",
      `yan378-run=${prefix}`,
      "--network",
      "host",
      "-v",
      `${data}:/app/data`,
      "-e",
      `PORT=${port}`,
      "-e",
      "HOSTNAME=127.0.0.1",
      ...(passwordEnv === null
        ? ["-e", "INITIAL_PASSWORD="]
        : ["-e", `INITIAL_PASSWORD=${passwordEnv}`]),
      "-e",
      `JWT_SECRET=${prefix}-synthetic-jwt`,
      "-e",
      `TOKENHOP_MULTI_USER=${mode}`,
      "-e",
      "TOKENHOP_OWNER_EMAIL=owner@yan378.fixture",
      image,
    );
    const base = `http://127.0.0.1:${port}`;
    // Terminal failure carries sanitized logs: enough to diagnose, never the
    // fixture secrets. The tick also ends the wait at once if the container dies.
    const jwtEnv = `${prefix}-synthetic-jwt`;
    const logTail = () => {
      try {
        return sanitizeLogs(docker("logs", "--tail", "80", name), [...secrets, PASSWORD, jwtEnv]);
      } catch {
        return "logs unavailable";
      }
    };
    const running = () => {
      try {
        return docker("inspect", "--format", "{{.State.Running}}", name) === "true";
      } catch {
        return false;
      }
    };
    try {
      await waitForHealth(base, {
        tick: async () => {
          if (!running()) {
            let state = "unknown";
            try {
              state = docker("inspect", "--format", "{{json .State}}", name);
            } catch {}
            throw new Error(`${name} startup crashed: ${state}\n${logTail()}`);
          }
        },
      });
    } catch (err) {
      const state = running() ? "still running" : "exited";
      throw new Error(`health failed, container ${state}: ${err.message}\n${logTail()}`);
    }
    // Refuse a foreign port answer: something else may listen on host network.
    const bound = JSON.parse(
      docker("exec", "--user", "node", name, "node", "-e", LISTEN_PROBE, String(port)),
    );
    assert(
      bound.owned,
      `${name}: port ${port} health answered by a foreign listener (${JSON.stringify(bound)})`,
    );
    assert(bound.loopback, `${name}: gateway bound beyond loopback (${bound.local})`);
    assert(
      Number(bound.owner) === 1,
      `${name}: listener owner pid ${bound.owner}, expected the container's pid 1 server`,
    );
    return { base, name, data, port, prefix };
  };
  const stop = (app) => {
    const r = spawnSync("docker", ["stop", "-t", "15", app.name], { encoding: "utf8" });
    assert.equal(r.status, 0, `docker stop ${app.name} failed: ${r.stderr}`);
    // 137 means SIGKILL after the grace period: a dirty WAL would invalidate the proof.
    const code = Number(docker("inspect", "--format", "{{.State.ExitCode}}", app.name));
    assert([0, 143].includes(code), `${app.name} did not stop cleanly: exit ${code}`);
  };
  // Start expected to fail closed: returns what an observer can see.
  const startExpectFail = async (image, data, mode, extraEnv = []) => {
    const port = await freePort();
    const name = `${prefix}-${++serial}`;
    names.add(name);
    docker(
      "run",
      "-d",
      "--name",
      name,
      "--label",
      `yan378-run=${prefix}`,
      "--network",
      "host",
      "-v",
      `${data}:/app/data`,
      "-e",
      `PORT=${port}`,
      "-e",
      "HOSTNAME=127.0.0.1",
      "-e",
      `JWT_SECRET=${prefix}-synthetic-jwt`,
      "-e",
      `TOKENHOP_MULTI_USER=${mode}`,
      ...extraEnv,
      image,
    );
    let state;
    for (let i = 0; i < 60; i++) {
      state = JSON.parse(docker("inspect", "--format", "{{json .State}}", name));
      if (!state.Running) break;
      await sleep(1000);
    }
    const base = `http://127.0.0.1:${port}`;
    // Distinguish "terminated" (container exited) from a RUNNING process whose
    // HTTP server is broken: a fatal-startup product keeps Running:true with
    // ExitCode 0 and answers 500 on every route. Track both, plus a raw TCP
    // listen check, because a fail-closed gateway must serve NOTHING: neither
    // a 2xx/3xx login nor any other healthy endpoint may appear.
    let loginStatus = null;
    let healthStatus = null;
    let listening = false;
    if (state.Running) {
      listening = await new Promise((resolve) => {
        const socket = net.connect({ host: "127.0.0.1", port, timeout: 2000 });
        socket.on("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.on("error", () => resolve(false));
        socket.on("timeout", () => {
          socket.destroy();
          resolve(false);
        });
      });
      if (listening) {
        try {
          const r = await fetch(`${base}/api/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: PASSWORD }),
            signal: AbortSignal.timeout(3000),
          });
          loginStatus = r.status;
        } catch {}
        try {
          healthStatus = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) }))
            .status;
        } catch {}
      }
    }
    const logs = sanitizeLogs(docker("logs", "--tail", "40", name), [...secrets, PASSWORD]);
    dockerQuiet("rm", "-f", name);
    // Fail-closed contract (no leniency for HTTP 500): the process must have
    // TERMINATED with a nonzero exit and left no listener. A Running:true
    // container that answers 500 is still a live server and is a failure.
    const fatalStartup =
      /MASTER_KEY_INVALID|KEY_MISSING|ACTIVATION_|DATA_DIR_UNVERIFIABLE_LOCK|DB_WRITER_LOCK_HELD/.test(
        logs,
      );
    const result = {
      exited: !state.Running,
      running: state.Running === true,
      exitCode: state.ExitCode,
      listening,
      loginStatus,
      healthStatus,
      fatalStartup,
      logs,
    };
    return { ...result, failedClosed: failedClosed(result) };
  };
  // Throwaway helper container with the scratch tree mounted (tracked + labeled).
  const helper = (entry, ...args) => {
    const name = `${prefix}-helper-${++serial}`;
    names.add(name);
    try {
      return docker(
        "run",
        "--rm",
        "--name",
        name,
        "--label",
        `yan378-run=${prefix}`,
        "--network",
        "none",
        "--entrypoint",
        entry,
        "-v",
        `${scratch}:/scratch`,
        MASTER,
        ...args,
      );
    } finally {
      rmContainer(name);
    }
  };
  const command = (app, code) =>
    docker("exec", "--user", "node", app.name, "node", "--input-type=module", "-e", code);
  const dbExec = (app, code) =>
    command(
      app,
      `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('/app/data/db/data.sqlite'); ${code} db.close();`,
    );
  const dbRead = (app, sql) =>
    JSON.parse(
      command(
        app,
        `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('/app/data/db/data.sqlite',{readOnly:true}); console.log(JSON.stringify(db.prepare(${JSON.stringify(sql)}).all())); db.close();`,
      ),
    );
  const dbDigest = (app) =>
    command(
      app,
      "import fs from 'node:fs';import{createHash}from'node:crypto';console.log(createHash('sha256').update(fs.readFileSync('/app/data/db/data.sqlite')).digest('hex'));",
    );
  // CLI runs IN the running container: only there do machine-id/cli-secret
  // (the host-local owner proof) and the loopback-peer source IP both hold.
  // Installed to /tmp: repo cli/ + the shared modules it resolves from source,
  // plus node-machine-id from the image (only CLI dep the keys path loads).
  const cliInstall = (app) => {
    const cp = (src, dst) => {
      const r = spawnSync("docker", ["cp", src, `${app.name}:${dst}`], { encoding: "utf8" });
      assert.equal(r.status, 0, `docker cp ${src}: ${r.stderr}`);
    };
    docker("exec", "--user", "node", app.name, "mkdir", "-p", "/tmp/yan378-cli/src");
    cp(path.join(ROOT, "cli"), "/tmp/yan378-cli/cli");
    cp(path.join(ROOT, "src", "shared"), "/tmp/yan378-cli/src/shared");
  };
  const cli = (app, ...cliArgs) => {
    const r = spawnSync(
      "docker",
      [
        "exec",
        "--user",
        "node",
        "-e",
        "NODE_PATH=/app/node_modules",
        app.name,
        "node",
        "/tmp/yan378-cli/cli/cli.js",
        ...cliArgs,
        "--port",
        String(app.port),
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    assert.equal(
      r.status,
      0,
      `CLI ${cliArgs.join(" ")} failed: ${(r.stdout || "") + (r.stderr || "")}`,
    );
    return r.stdout;
  };
  return {
    scratch,
    prefix,
    start,
    stop,
    startExpectFail,
    helper,
    cleanup,
    command,
    dbExec,
    dbRead,
    dbDigest,
    cli,
    cliInstall,
    upstream: `${up.url}/v1`,
    idp: idpMock.url,
    setIdentity: idpMock.setIdentity,
    hits: up.hits,
    sha256,
  };
}
