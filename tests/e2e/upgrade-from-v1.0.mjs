#!/usr/bin/env node
// YAN-378 manual Docker rehearsal. Node >=22.23.4, Linux host networking; no deps.
// node tests/e2e/upgrade-from-v1.0.mjs [--reuse-master]
// Default pulls published 1.0.3 and builds this checkout as yan378-master
// labeled with a fingerprint of HEAD + tracked diff + untracked contents;
// --reuse-master reuses only a fingerprint-matching image and prints IDs.
// Operator-configured provider URLs permit loopback (fetchTrusted), unlike
// user-supplied fetch/validate URLs; no SSRF guard is disabled or patched.
// Helpers live in ./upgrade-v1/; re-exported here for the bench import.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chat, login, oidcLogin, ownerLoginFrom, seed } from "./upgrade-v1/client.mjs";
import { check, docker, failureCount, MASTER, OLD, prepareImages } from "./upgrade-v1/core.mjs";
import {
  backupInfo,
  markers,
  privateRoot,
  SCHEMA_SQL,
  seedTotals,
  tableShells,
  storageEvidence,
  waitRows,
} from "./upgrade-v1/evidence.mjs";
import { harness } from "./upgrade-v1/harness.mjs";
import { isolationChecks } from "./upgrade-v1/isolation.mjs";

export * from "./upgrade-v1/client.mjs";
export { failedClosed as failedClosedContract } from "./upgrade-v1/harness.mjs";
export * from "./upgrade-v1/core.mjs";
export * from "./upgrade-v1/evidence.mjs";
export * from "./upgrade-v1/harness.mjs";
export * from "./upgrade-v1/isolation.mjs";

async function main() {
  await prepareImages();
  const h = await harness();
  try {
    const data = path.join(h.scratch, "data");
    console.log("== v1.0.3 seed");
    const old = await h.start(OLD, data);
    const fixture = await seed(h, old);
    for (let i = 0; i < 200; i++) {
      const result = await chat(
        old,
        fixture.keys[i % 2],
        i % 2 ? "yan378-combo-b" : "yan378-combo-a",
        i % 2 === 0,
      );
      assert(
        result.ok && result.text.includes(i % 2 === 0 ? "[DONE]" : "chatcmpl"),
        `seed chat ${i}: HTTP ${result.status}`,
      );
    }
    await waitRows(h, old, 200);
    check("200 usage history rows seeded", true, `mock hits=${h.hits()}`);
    seedTotals(h, old, 200);
    // Positive control for the activation scans: the pre-upgrade DB must
    // contain the sentinels in bytes and rows, else the later "absent" proof
    // proves nothing.
    storageEvidence(h, old, fixture.keys, false);
    const v103Schema = h.dbRead(old, SCHEMA_SQL);
    h.stop(old);

    const verify = async (app, on) => {
      const c = await login(app, on);
      const ws = on ? (await c.call("GET", "/api/workspaces")).json.workspaces : [];
      const defaultWs = ws.find((w) => w.name === "Default")?.id;
      const keyRoute = on ? `/api/keys?workspaceId=${defaultWs}` : "/api/keys";
      const keys = await c.call("GET", keyRoute);
      check("two keys retained", keys.ok && keys.json.keys.length === 2);
      for (const key of fixture.keys) check("old key routes chat", (await chat(app, key)).ok);
      for (const [route, values] of [
        ["/api/combos", ["yan378-combo-a", "yan378-combo-b"]],
        ["/api/models/alias", ["yan378-alias"]],
        ["/api/providers", [fixture.conn]],
        ["/api/provider-nodes", [fixture.node]],
        ["/api/settings", [h.idp, "urn:yan378:sp", "https://idp.yan378.invalid/sso"]],
      ]) {
        const r = await c.call("GET", route);
        check(`${route} retained`, r.ok && values.every((v) => r.text.includes(v)));
      }
      const usage = await c.call("GET", "/api/usage/stats?period=all");
      check(
        "usage counts retained",
        usage.ok && usage.json.totalRequests >= 200,
        `requests=${usage.json?.totalRequests}`,
      );
      const settings = await c.call("GET", "/api/settings");
      check("SAML issuer survives upgrade", settings.json.samlIssuer === "urn:yan378:sp");
      h.cliInstall(app);
      try {
        check(
          "CLI cli/cli.js keys list",
          h.cli(app, "keys", "list", "--json").includes("yan378-key-1"),
        );
      } catch (err) {
        check("CLI cli/cli.js keys list", false, err.message);
      }
      return { c, defaultWs, ws };
    };

    console.log("== Leg A master off (no INITIAL_PASSWORD: stored hash must authenticate)");
    const off = await h.start(MASTER, data, "off", null);
    await verify(off, false);
    check(
      "leg A activation markers absent",
      markers(h, off).length === 0,
      JSON.stringify(markers(h, off)),
    );
    const backups = JSON.parse(
      h.command(
        off,
        "import fs from 'node:fs'; console.log(JSON.stringify(fs.readdirSync('/app/data/db/backups').filter(n=>n.startsWith('schema-')).sort()));",
      ),
    );
    check("pre-schema migration backup exists", backups.length > 0);
    const rollbackBackup = backups[0]; // Pre-schema backup, not post-bootstrap activation snapshot.
    const backupSchema = JSON.parse(
      h.command(
        off,
        `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('/app/data/db/backups/${rollbackBackup}/data.sqlite',{readOnly:true}); console.log(JSON.stringify(db.prepare(${JSON.stringify(SCHEMA_SQL)}).all())); db.close();`,
      ),
    );
    // product semantic: backup shells match (backupDbLite copies table DDL +
    // rows only); indexes/triggers/requestDetails-full-schema are omitted by
    // design and out of scope here. BACKUP_DIFF reporting is for forensics.
    const expectedShells = tableShells(v103Schema).filter((t) => t.name !== "requestDetails");
    const actualShells = tableShells(backupSchema);
    check(
      "rollback backup tables match v1.0.3 shells (indexes/requestDetails excluded by design)",
      JSON.stringify(actualShells) === JSON.stringify(expectedShells),
    );
    h.stop(off);

    console.log("== Leg B master on (INITIAL_PASSWORD removed: stored hash + hashed keys)");
    const on = await h.start(MASTER, data, "on", null);
    const legB = await verify(on, true);
    Object.assign(fixture, { c: legB.c, defaultWs: legB.defaultWs });
    check("activation markers exist", markers(h, on).length === 2, JSON.stringify(markers(h, on)));
    const activation = backupInfo(h, on);
    check(
      "protected pre-activation backup exists",
      activation.length >= 1,
      activation.map((b) => b.name).join(","),
    );
    check(
      "activation backup is pre-activation (legacy, both keys)",
      activation[0].markers.length === 0 && activation[0].keys === 2,
      JSON.stringify(activation[0]),
    );
    check(
      "activation backup integrity ok, private modes",
      activation[0].integrity === "ok" &&
        activation[0].dirMode === 0o700 &&
        activation[0].fileMode === 0o600,
    );
    storageEvidence(h, on, fixture.keys, true);
    privateRoot(h, on);
    await oidcLogin(on);
    await isolationChecks(h, on, fixture);
    await waitRows(h, on, 204);
    seedTotals(h, on, 204); // 200 seeded + two verify chats in each leg
    h.stop(on);

    console.log("== Leg B restart: no second activation");
    const on2 = await h.start(MASTER, data, "on", null);
    const ownerLogin = ownerLoginFrom(
      h.dbRead(
        on2,
        "SELECT username,email FROM users WHERE instanceRole='owner' AND status='active'",
      ),
    );
    const again = backupInfo(h, on2);
    check(
      "no second activation backup",
      again.length === activation.length,
      again.map((b) => b.name).join(","),
    );
    const snapshot = JSON.stringify({
      markers: markers(h, on2),
      activation: again.map((a) => a.name),
    });
    await login(on2, true, ownerLogin);
    check(
      "restart markers unchanged",
      JSON.stringify({
        markers: markers(h, on2),
        activation: backupInfo(h, on2).map((a) => a.name),
      }) === snapshot,
    );
    // Exact usage count at the leg-B end, verified BEFORE the recovery copy and
    // restore: the rolled-back snapshot must NOT contain these rows, and the
    // fail-closed/hashed-compat legs must not change them.
    await waitRows(h, on2, 204);
    check(
      "leg-B-end usage exact (pre-copy)",
      h.dbRead(on2, "SELECT COUNT(*) n FROM usageHistory")[0].n === 204,
    );
    h.stop(on2);
    // Copy/digest the recovery state IMMEDIATELY after the graceful stop, before
    // any fail-closed/hashed-compat leg can touch the volume; restore later
    // comes from this snapshot. docker cp works on the stopped container.
    const recovery = path.join(h.scratch, "recovery");
    fs.mkdirSync(recovery);
    docker("cp", `${on2.name}:/app/data/db/.`, recovery);
    const restored = path.join(h.scratch, "restore.sqlite");
    docker("cp", `${on2.name}:/app/data/db/backups/${rollbackBackup}/data.sqlite`, restored);
    const restoredDigest = h.sha256(restored);
    // Digest AFTER the graceful stop (stop checkpoints the WAL into the file),
    // read through a helper container, so the wrong-root comparison is stable.
    const dbFile = "/scratch/data/db/data.sqlite";
    const digestOf = () =>
      h.helper(
        "node",
        "--input-type=module",
        "-e",
        `import fs from 'node:fs';import{createHash}from'node:crypto';console.log(createHash('sha256').update(fs.readFileSync('${dbFile}')).digest('hex'));`,
      );
    const beforeRootFailure = digestOf();
    check(
      "recovery copy equals activated DB at leg-B end",
      h.sha256(path.join(recovery, "data.sqlite")) === beforeRootFailure,
    );

    console.log("== Switch-off after activation (hashed-compat) and wrong root fail closed");
    const offAfter = await h.startExpectFail(MASTER, data, "off", [
      "-e",
      "TOKENHOP_MASTER_KEY=wrong",
    ]);
    const failDetail = (r) =>
      `running=${r.running} exit=${r.exitCode} listening=${r.listening} login=${r.loginStatus} health=${r.healthStatus} fatal=${r.fatalStartup}`;
    check(
      "wrong root fails closed (terminated, nonzero, no listener)",
      offAfter.failedClosed,
      failDetail(offAfter),
    );
    check("activated DB untouched by wrong root", digestOf() === beforeRootFailure); // on2 stopped before this leg
    const offCompat = await h.start(MASTER, data, "off", null);
    await login(offCompat, true, ownerLogin);
    check(
      "hashed-compat keeps markers",
      markers(h, offCompat).length === 2,
      JSON.stringify(markers(h, offCompat)),
    );
    h.stop(offCompat);
    h.helper("sh", "-c", "mv /scratch/data/keys/master /scratch/root.saved");
    const missingRoot = await h.startExpectFail(MASTER, data, "on", []);
    check(
      "missing root after encryption fails closed (terminated, nonzero, no listener)",
      missingRoot.failedClosed,
      failDetail(missingRoot),
    );
    check(
      "fail-closed restarts never served traffic",
      !offAfter.listening &&
        !missingRoot.listening &&
        offAfter.loginStatus == null &&
        missingRoot.loginStatus == null,
    );
    h.helper("sh", "-c", "mv /scratch/root.saved /scratch/data/keys/master");

    console.log("== Rollback per UPGRADING.md");
    // Only usageHistory is asserted after rollback: automatic backups exclude
    // the requestDetails log (backup.js BACKUP_EXCLUDE_TABLES), so request logs
    // are intentionally not part of the restored state and not compared.
    // Recovery state was copied and digested right after the leg-B stop, before
    // any fail-closed / hashed-compat leg could touch the volume.
    h.helper(
      "sh",
      "-c",
      "rm -f /scratch/data/db/data.sqlite-wal /scratch/data/db/data.sqlite-shm; cp /scratch/restore.sqlite /scratch/data/db/data.sqlite",
    );
    const restoredProof = JSON.parse(
      h.helper(
        "node",
        "--input-type=module",
        "-e",
        "import fs from 'node:fs';import{createHash}from'node:crypto';import{DatabaseSync}from'node:sqlite';const p='/scratch/data/db/data.sqlite';const sha=createHash('sha256').update(fs.readFileSync(p)).digest('hex');const journals=['-wal','-shm'].filter(s=>fs.existsSync(p+s));const db=new DatabaseSync(p,{readOnly:true});const integrity=db.prepare('PRAGMA integrity_check').get().integrity_check;db.close();console.log(JSON.stringify({sha,journals,integrity}));",
      ),
    );
    check("restored file sha256 equals backup", restoredProof.sha === restoredDigest);
    check(
      "restored DB integrity and no stale journals BEFORE start",
      restoredProof.integrity === "ok" && restoredProof.journals.length === 0,
      JSON.stringify(restoredProof),
    );
    const rollback = await h.start(OLD, data, "off", `different-${randomBytes(6).toString("hex")}`);
    check(
      "restored DB integrity_check ok",
      h.dbRead(rollback, "PRAGMA integrity_check")[0].integrity_check === "ok",
    );
    // Full live rollback DB: master opens (and therefore creates) every
    // index/trigger, so the complete schema must round-trip, unlike the
    // deliberately shell-only backup snapshot checked before.
    const restoredSchema = h.dbRead(rollback, SCHEMA_SQL);
    check(
      "rollback schema complete (tables+indexes+triggers)",
      JSON.stringify(restoredSchema) === JSON.stringify(v103Schema),
    );
    const r = await login(rollback, true); // distinct INITIAL_PASSWORD: only the stored hash can work
    check("rollback keys intact", (await r.call("GET", "/api/keys")).json.keys.length === 2);
    check("rollback combos intact", (await r.call("GET", "/api/combos")).json.combos.length === 2);
    check(
      "rollback aliases intact",
      (await r.call("GET", "/api/models/alias")).json.aliases["yan378-alias"] === "fx/gpt-4o-mini",
    );
    check(
      "rollback node intact",
      (await r.call("GET", "/api/provider-nodes")).json.nodes.some((n) => n.id === fixture.node),
    );
    check(
      "rollback connection intact",
      (await r.call("GET", "/api/providers")).json.connections.some((c) => c.id === fixture.conn),
    );
    const rollbackSettings = await r.call("GET", "/api/settings");
    check(
      "rollback SSO settings intact",
      rollbackSettings.json.samlIssuer === "urn:yan378:sp" &&
        rollbackSettings.json.samlEntryPoint === "https://idp.yan378.invalid/sso" &&
        rollbackSettings.json.oidcIssuerUrl === h.idp,
    );
    const rolledBack = h.dbRead(rollback, "SELECT COUNT(*) n FROM usageHistory")[0].n;
    // Restored snapshot predates leg A: exactly the seeded rows (later traffic is not restored).
    check("rollback usage exact pre-migration count", rolledBack === 200, `rows=${rolledBack}`);
    for (const key of fixture.keys)
      check("rollback old key routes", (await chat(rollback, key)).ok);
    h.stop(rollback);
    console.log(failureCount() ? `${failureCount()} FAILED` : "ALL PASSED");
    if (failureCount()) process.exitCode = 1;
  } finally {
    h.cleanup();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (err) {
    console.error(`FAIL ${err.message}`);
    process.exitCode = 1;
  }
}
