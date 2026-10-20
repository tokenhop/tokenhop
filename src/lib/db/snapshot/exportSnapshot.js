// Full-instance export to a private staging file (bounded memory) and the
// in-memory `exportDb()` built on top of it.
//
// Consistency: every await happens first (settings, multi-user switch, master
// key + scrypt for portable exports). Then ONE synchronous section builds the
// head, writes the head keys and pages the telemetry sections into the file,
// so no write can interleave between the head and the section rows.
import fs from "node:fs";
import path from "node:path";
import { getAdapter } from "../driver.js";
import { parseJson } from "../helpers/jsonCol.js";
import { latestVersion } from "../migrations/index.js";
import { defaultWorkspaceIdUnscoped } from "../repos/ownership.js";
import { makeInstancePortable } from "../helpers/instancePortable.js";
import {
  TransferError,
  exportGatewayKeySnapshot,
  gatewayKeyStorageSnapshot,
} from "../helpers/gatewayKeyTransfer.js";
import { makeStagingDir, openPrivateFileSync, removeStagingDir } from "../stagingFiles.js";
import { isLegacyDefaultKey, stripWsKey } from "./legacyKeys.js";
import { assertExportDiskSpace } from "../diskPreflight.js";
import { withInstanceExportLock } from "./transferLock.js";
import { writeSnapshotFileSync } from "./exportWriter.js";

// Legacy single-user snapshot shape (copied from the barrel's exportDb; the
// barrel's body is deleted once it re-exports this module).
function buildLegacyHead(db, settings) {
  const defaultWs = defaultWorkspaceIdUnscoped(db);
  const out = {
    schemaVersion: latestVersion(),
    settings,
    providerConnections: db.all(`SELECT * FROM providerConnections`).map((r) => ({
      ...parseJson(r.data, {}),
      id: r.id,
      provider: r.provider,
      authType: r.authType,
      name: r.name,
      email: r.email,
      priority: r.priority,
      isActive: r.isActive === 1,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    providerNodes: db.all(`SELECT * FROM providerNodes`).map((r) => ({
      ...parseJson(r.data, {}),
      id: r.id,
      type: r.type,
      name: r.name,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    proxyPools: db.all(`SELECT * FROM proxyPools`).map((r) => ({
      ...parseJson(r.data, {}),
      id: r.id,
      isActive: r.isActive === 1,
      testStatus: r.testStatus,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    apiKeys: db.all(`SELECT * FROM apiKeys`).map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      machineId: r.machineId,
      isActive: r.isActive === 1,
      createdAt: r.createdAt,
    })),
    combos: db.all(`SELECT * FROM combos`).map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      models: parseJson(r.models, []),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    modelAliases: {},
    disabledModels: {},
    customModels: [],
    mitmAlias: {},
    cliToolSettings: {},
    cliToolPresets: {},
    pricing: {},
  };

  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) {
    if (!isLegacyDefaultKey(r.key, defaultWs)) continue;
    out.modelAliases[stripWsKey(r.key)] = parseJson(r.value);
  }
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'disabledModels'`)) {
    if (!isLegacyDefaultKey(r.key, defaultWs)) continue;
    const ids = parseJson(r.value, []);
    out.disabledModels[stripWsKey(r.key)] = Array.isArray(ids) ? ids : [];
  }
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) {
    if (!isLegacyDefaultKey(r.key, defaultWs)) continue;
    out.customModels.push(parseJson(r.value));
  }
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`))
    out.mitmAlias[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'cliToolSettings'`))
    out.cliToolSettings[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'cliToolPresets'`))
    out.cliToolPresets[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`))
    out.pricing[r.key] = parseJson(r.value);
  return out;
}

// Head with the 9 instance sections deferred (STREAMED_SECTION placeholders).
function buildHead(db, settings, multiUserTransfer) {
  const out = buildLegacyHead(db, settings);
  return exportGatewayKeySnapshot(db, out, gatewayKeyStorageSnapshot(db), {
    multiUserTransfer,
    deferSections: multiUserTransfer,
  });
}

// The parts of a head a portable bundle is bound to. If they differ between
// head #1 (bundle source) and head #2 (written), the bundle no longer matches.
function credentialGraph(head) {
  return JSON.stringify([
    head.credentialEncryption
      ? [
          head.credentialEncryption.version,
          head.credentialEncryption.kekKid,
          head.credentialEncryption.apiKeyHashKeyWrapped,
        ]
      : null,
    head.workspaceKeys ?? null,
    head.apiKeyStorage ?? null,
    head.tenancy ?? null,
  ]);
}

async function portableBundle(db, settings, multiUserTransfer, passphrase) {
  const head1 = buildHead(db, settings, multiUserTransfer);
  if (!head1.credentialEncryption) {
    throw new TransferError(
      "TRANSFER_PORTABLE_UNSUPPORTED",
      "Passphrase-protected exports need encrypted credentials",
    );
  }
  const { loadMasterKey } = await import("@/lib/security/masterKey.js");
  const root = await loadMasterKey();
  try {
    if (root.kid !== head1.credentialEncryption.kekKid) {
      throw new TransferError(
        "TRANSFER_ROOT_MISMATCH",
        "Trusted master key does not match this instance's root",
      );
    }
    // Head-only: the deferred sections are placeholders, so this clones only the small head.
    const portable = await makeInstancePortable(head1, { passphrase, masterKey: root.key });
    return { graph: credentialGraph(head1), bundle: portable.credentialEncryption.portable };
  } finally {
    root.key.fill(0);
  }
}

/**
 * Export the instance to a private staging file.
 * @param {{ passphrase?: string, __onProgress?: Function, __maxRowBytes?: number }} [opts]
 * @returns {Promise<{ file: string, size: number, openStream: () => fs.ReadStream, cleanup: () => void }>}
 */
export function exportDbToFile(opts = {}) {
  return withInstanceExportLock(() => exportDbToFileUnlocked(opts));
}

async function exportDbToFileUnlocked({ passphrase, __onProgress, __maxRowBytes } = {}) {
  // ---- async preparation (all awaits happen before the sync section) ----
  const db = await getAdapter();
  const { exportSettings } = await import("../repos/settingsRepo.js");
  const settings = await exportSettings();
  const { isMultiUserEnabled } = await import("@/lib/users/featureSwitch.js");
  const multiUserTransfer = await isMultiUserEnabled();
  let portable = null;
  if (passphrase !== undefined) {
    if (!multiUserTransfer) {
      // Same precedence as before: the head build (its own failures) comes first.
      buildHead(db, settings, multiUserTransfer);
      throw new TransferError(
        "TRANSFER_PORTABLE_UNSUPPORTED",
        "Passphrase exports require Users & teams",
      );
    }
    portable = await portableBundle(db, settings, multiUserTransfer, passphrase);
  }

  // ---- synchronous section: head build + file write, no await ----
  // By design (D3) this section blocks the event loop for the whole write:
  // nothing may interleave a write between the head and the last section page.
  assertExportDiskSpace();
  const dir = makeStagingDir("export-");
  let fd = null;
  try {
    const head = buildHead(db, settings, multiUserTransfer);
    if (portable) {
      if (credentialGraph(head) !== portable.graph) {
        throw new TransferError(
          "TRANSFER_STATE_CHANGED",
          "Instance credentials changed during export; retry",
        );
      }
      head.credentialEncryption.portable = portable.bundle;
    }
    const file = path.join(dir, "snapshot.json");
    fd = openPrivateFileSync(file);
    const { bytes } = writeSnapshotFileSync(db, head, fd, {
      onProgress: __onProgress,
      ...(__maxRowBytes === undefined ? {} : { maxRowBytes: __maxRowBytes }),
    });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    return makeHandle(dir, file, bytes);
  } catch (e) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    removeStagingDir(dir);
    throw e;
  }
}

function makeHandle(dir, file, size) {
  const cleanup = () => {
    removeStagingDir(dir);
  };
  return {
    file,
    size,
    cleanup,
    openStream() {
      const fd = fs.openSync(file, "r");
      try {
        // POSIX: the open fd keeps the data alive, so nothing can leak.
        if (process.platform !== "win32") removeStagingDir(dir);
        const stream = fs.createReadStream(null, { fd, autoClose: true });
        stream.once("close", cleanup);
        stream.once("error", cleanup);
        return stream;
      } catch (e) {
        try {
          fs.closeSync(fd);
        } catch {}
        cleanup();
        throw e;
      }
    },
  };
}

/**
 * In-memory export (tests / legacy callers): file export → parse → cleanup.
 * Same object contract as before, produced by the single streaming code path.
 */
export async function exportDb(opts = {}) {
  const handle = await exportDbToFile(opts);
  try {
    return JSON.parse(fs.readFileSync(handle.file, "utf8"));
  } finally {
    handle.cleanup();
  }
}
