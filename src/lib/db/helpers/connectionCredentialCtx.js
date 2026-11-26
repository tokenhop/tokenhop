import { prepareCredentialContext } from "./credentialStorage.js";
import {
  readCredentialEncryptionState,
  readCredentialMarkerValues,
} from "../credentialEncryptionState.js";
import { loadMasterKey } from "../../security/masterKey.js";
import { assertCredentialOperationAllowed } from "../credentialMaintenance.js";

function repoFail(code, message) {
  throw Object.assign(new Error(`[credential-repo] ${message}`), { code });
}

// ─── YAN-365 credential context facade ────────────────────────────────────
// Async outer facade: the root is loaded (env/file via masterKey, kid checked
// against the stored marker) BEFORE the sync transaction; the sync row codec
// then runs entirely inside it. Legacy installs never touch the key store.

/**
 * Resolve the runtime credential context for `db` (repo-internal write paths
 * and nodesRepo). Trusted loaders only: the root comes from masterKey, never a
 * caller. The gateway read path never calls this — it goes through
 * decodeRequestCredentialRows, which returns row data only, never the ctx.
 * @returns {Promise<object>} context for decode/encodeCredentialRowSync
 */
export async function prepareCredentialCtx(db) {
  assertCredentialOperationAllowed(db);
  const state = readCredentialEncryptionState(db);
  if (state.storage !== "encrypted") return prepareCredentialContext(db, null, { state });
  const before = JSON.stringify(readCredentialMarkerValues(db));
  // The root load yields: poison or a committed rotation must not slip through,
  // whether the load succeeds or fails (typed KEY_MISMATCH retry on change).
  const recheck = () => {
    assertCredentialOperationAllowed(db);
    if (JSON.stringify(readCredentialMarkerValues(db)) !== before) {
      repoFail("KEY_MISMATCH", "credential encryption state changed during the operation; retry");
    }
  };
  let root;
  try {
    root = await loadMasterKey({ expectedKid: state.kekKid });
  } catch (error) {
    recheck();
    throw error;
  }
  recheck();
  return prepareCredentialContext(db, root, { state });
}

/**
 * Re-verify the live marker inside a sync write: an activation/rotation that
 * committed while this context was being prepared must abort the write with a
 * typed error instead of persisting plaintext or wrong-KEK envelopes.
 */
export function assertCredentialCtxCurrent(db, ctx) {
  const live = readCredentialEncryptionState(db);
  if (live.storage !== ctx.state.storage || live.kekKid !== ctx.state.kekKid) {
    repoFail("KEY_MISMATCH", "credential encryption state changed during the operation; retry");
  }
}
