// YAN-365 (D4) durable credential-encryption marker reader — strict, sync,
// inert. No feature-switch, barrel, session or driver imports: this module
// must stay cycle-free like apiKeyState.js. Half/corrupt markers throw
// CREDENTIAL_STATE_INVALID; unexpected key rows, a wrapped hash key or stored
// envelopes without a coherent marker never read as "legacy" (fail closed).
import { CREDENTIAL_FIELD_ALLOWLIST, isEnvelopeShape } from "../security/envelope.js";

const KID_RE = /^[0-9a-f]{16}$/;
const PSD_PREFIX = "providerSpecificData.";

function failState(message) {
  throw Object.assign(new Error(`[credential-state] ${message}`), {
    code: "CREDENTIAL_STATE_INVALID",
  });
}

function metaValue(db, key) {
  return db.get(`SELECT value FROM _meta WHERE key = ?`, [key])?.value ?? null;
}

function tableExists(db, table) {
  return !!db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);
}

function parsePendingRotation(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failState("credentialsPendingRotation is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failState("credentialsPendingRotation must be an object");
  }
  const { oldKid, newKid } = parsed;
  if (typeof oldKid !== "string" || !KID_RE.test(oldKid)) {
    return failState("credentialsPendingRotation.oldKid must be a 16-hex key id");
  }
  if (typeof newKid !== "string" || !KID_RE.test(newKid)) {
    return failState("credentialsPendingRotation.newKid must be a 16-hex key id");
  }
  return { oldKid, newKid };
}

// Full-coverage existence scan (no row cap): an envelope-shaped leaf in any
// covered table means an activation/restore half-failed — never classify that
// DB as legacy. SQL pre-filters candidates (all three of the iv/ct/tag keys
// present, or any JSON \u escape that could hide them) so only rare rows are
// parsed. Sync and read-only.
function sniffStoredEnvelopes(db) {
  for (const table of Object.keys(CREDENTIAL_FIELD_ALLOWLIST)) {
    if (!tableExists(db, table)) continue;
    let rows;
    try {
      rows = db.all(
        `SELECT data FROM ${table} WHERE (instr(data, '"iv"') > 0 AND instr(data, '"ct"') > 0 AND instr(data, '"tag"') > 0) OR instr(data, char(92) || 'u') > 0`,
      );
    } catch {
      continue;
    }
    for (const { data } of rows) {
      if (typeof data !== "string") continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      for (const field of CREDENTIAL_FIELD_ALLOWLIST[table]) {
        if (field.startsWith(PSD_PREFIX)) {
          const psd = parsed.providerSpecificData;
          if (
            psd &&
            typeof psd === "object" &&
            !Array.isArray(psd) &&
            isEnvelopeShape(psd[field.slice(PSD_PREFIX.length)])
          ) {
            return true;
          }
        } else if (isEnvelopeShape(parsed[field])) {
          return true;
        }
      }
    }
  }
  return false;
}

function workspaceKeyCount(db) {
  if (!tableExists(db, "workspaceKeys")) return 0;
  return db.get(`SELECT COUNT(*) AS c FROM workspaceKeys`).c;
}

/**
 * Strict sync read of the `_meta` marker pair plus cleanup/rotation state.
 * Half/corrupt markers always throw. The full three-table envelope sniff
 * (O(rows)) only runs with `{ strict: true }`: startup readiness, activation
 * and import preflight. Runtime callers use the marker-only default; that is
 * safe because activation writes envelopes and the marker in ONE transaction
 * and imports are preflighted, so envelopes cannot appear at runtime without
 * the marker.
 * @param {object} db adapter.
 * @param {{ strict?: boolean }} [options]
 * @returns {{storage:"legacy",version:null,kekKid:null,cleanupPending:false,pendingRotation:null}
 *           |{storage:"encrypted",version:1,kekKid:string,cleanupPending:boolean,pendingRotation:{oldKid:string,newKid:string}|null}}
 */
export function readCredentialEncryptionState(db, { strict = false } = {}) {
  const version = metaValue(db, "credentialsEncryptedVersion");
  const kekKid = metaValue(db, "credentialsKekKid");
  const cleanupRaw = metaValue(db, "credentialsCleanupPending");
  const pendingRaw = metaValue(db, "credentialsPendingRotation");
  const hashWrappedRaw = metaValue(db, "apiKeyHashKeyWrapped");

  if (cleanupRaw !== null && cleanupRaw !== "0" && cleanupRaw !== "1") {
    failState("credentialsCleanupPending must be 0 or 1");
  }
  const pendingRotation = pendingRaw === null ? null : parsePendingRotation(pendingRaw);

  if (version === null && kekKid === null) {
    if (cleanupRaw !== null || pendingRotation !== null) {
      failState("cleanup/rotation state without an encryption marker");
    }
    if (hashWrappedRaw !== null) {
      failState("wrapped API-key hash key exists without an encryption marker");
    }
    if (workspaceKeyCount(db) > 0) {
      failState("workspace key rows exist without an encryption marker");
    }
    if (strict && sniffStoredEnvelopes(db)) {
      failState("credential envelopes exist without an encryption marker");
    }
    return {
      storage: "legacy",
      version: null,
      kekKid: null,
      cleanupPending: false,
      pendingRotation: null,
    };
  }
  if (version !== "1") failState("credentialsEncryptedVersion must be 1 when set");
  if (typeof kekKid !== "string" || !KID_RE.test(kekKid)) {
    failState("credentialsKekKid must be 16 hex chars when set");
  }
  if (hashWrappedRaw === null) {
    failState("encrypted state is missing the wrapped API-key hash key");
  }
  // A rotation in flight always targets the current marker kid (DB commit
  // writes both together); anything else is a corrupt/forged pairing.
  if (pendingRotation && pendingRotation.newKid !== kekKid) {
    failState("credentialsPendingRotation.newKid must equal credentialsKekKid");
  }
  return {
    storage: "encrypted",
    version: 1,
    kekKid,
    cleanupPending: cleanupRaw === "1",
    pendingRotation,
  };
}
