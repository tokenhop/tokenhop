// YAN-378 rehearsal core: image provenance and fail-visible checks.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "../../..");
export const OLD = "ghcr.io/tokenhop/tokenhop:1.0.3";
export const MASTER = "yan378-master";
export const PASSWORD = "yan378-SyntheticPassword-42";
export const PROVIDER_SECRET = "sk-yan378-synthetic-provider-sentinel";
export const OIDC_SECRET = "yan378-synthetic-oidc-secret-sentinel";
export const SAML_CERT = "MIIC123456789012345678901234567890123456789012345678901234567890";
export const secrets = [PROVIDER_SECRET, OIDC_SECRET];
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const FINGERPRINT_LABEL = "io.tokenhop.yan378.source";
export function docker(...args) {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(r.status, 0, `docker ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
}
export function dockerQuiet(...args) {
  return spawnSync("docker", args, { stdio: "ignore" });
}
export function preflight() {
  assert.equal(process.platform, "linux", "Linux host networking required");
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  assert(
    major > 22 || (major === 22 && (minor > 23 || (minor === 23 && patch >= 4))),
    "Node >=22.23.4 required",
  );
  const context = JSON.parse(docker("context", "inspect"))[0];
  const endpoint = process.env.DOCKER_HOST || context.Endpoints.docker.Host;
  assert(endpoint.startsWith("unix://"), "Docker daemon must be local Unix socket");
  const info = JSON.parse(docker("info", "--format", "{{json .}}"));
  assert.equal(info.OSType, "linux");
  assert.equal(info.Name, os.hostname(), "daemon and mock must share Linux host");
  console.log(`PREFLIGHT node=${process.version} docker=${info.ServerVersion} host=${info.Name}`);
}
function git(...args) {
  const r = spawnSync("git", args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, "git fingerprint failed");
  return r.stdout;
}
export function fingerprint() {
  const hash = createHash("sha256");
  const head = git("rev-parse", "HEAD").toString().trim();
  hash.update(head).update(git("diff", "HEAD", "--binary"));
  const files = git("ls-files", "--others", "--exclude-standard", "-z")
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const file of files) {
    const full = path.join(ROOT, file);
    const stat = fs.lstatSync(full);
    const data = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(full)) : fs.readFileSync(full);
    hash.update(`${file}\0${stat.mode}\0${data.length}\0`).update(data);
  }
  return { head, hash: hash.digest("hex") };
}
export async function prepareImages() {
  preflight();
  const source = fingerprint();
  const commands = [["pull", OLD]];
  if (!process.argv.includes("--reuse-master"))
    commands.push([
      "build",
      "--build-arg",
      "APK_MIRROR=dl-cdn.alpinelinux.org",
      "--build-arg",
      "NPM_REGISTRY=https://registry.npmjs.org",
      "--label",
      `${FINGERPRINT_LABEL}=${source.hash}`,
      "--label",
      `io.tokenhop.yan378.head=${source.head}`,
      "-t",
      MASTER,
      ".",
    ]);
  for (const args of commands) {
    console.log(`COMMAND docker ${args.join(" ")}`);
    await new Promise((resolve, reject) => {
      const child = spawn("docker", args, { cwd: ROOT, stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`docker ${args[0]} exit ${code}`)),
      );
    });
  }
  assert.equal(fingerprint().hash, source.hash, "checkout changed during image build");
  const master = JSON.parse(docker("image", "inspect", MASTER))[0];
  assert.equal(
    master.Config.Labels?.[FINGERPRINT_LABEL],
    source.hash,
    "master image stale: rebuild without --reuse-master",
  );
  const old = JSON.parse(docker("image", "inspect", OLD))[0];
  assert.equal(old.Config.Labels?.["org.opencontainers.image.version"], "v1.0.3");
  assert(old.RepoDigests.length > 0, "release RepoDigest missing");
  console.log(`IMAGE master=${master.Id} HEAD=${source.head} source=${source.hash}`);
  console.log(
    `EVIDENCE=${process.argv.includes("--final") ? "final" : "baseline (source still changing; not final evidence)"}`,
  );
  console.log(`IMAGE 1.0.3=${old.Id} RepoDigest=${old.RepoDigests.join(",")} version=v1.0.3`);
}
let failures = 0;
export const failureCount = () => failures;
export const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
  return ok;
};
export const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
