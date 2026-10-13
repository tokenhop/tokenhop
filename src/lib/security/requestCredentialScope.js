import { loadMasterKey } from "./masterKey.js";
import {
  readCredentialEncryptionState,
  readCredentialMarkerValues,
} from "../db/credentialEncryptionState.js";
import { assertCredentialOperationAllowed } from "../db/credentialMaintenance.js";
import {
  DEK_CACHE_TTL_MS,
  decodeCredentialRowSync,
  prepareCredentialContext,
} from "../db/helpers/credentialStorage.js";
import { zeroBuffer } from "./envelope.js";

// Server-only mint boundary. Frozen copies/foreign principals cannot acquire a scope.
const scopes = new WeakMap();

function changed() {
  return Object.assign(new Error("credential encryption state changed during the request; retry"), {
    code: "KEY_MISMATCH",
  });
}

const signature = (db) => JSON.stringify(readCredentialMarkerValues(db));

// Live fallback still yields while loading the root. Prove markers and poison
// after success OR failure, so a concurrent rotation yields a typed retry.
async function liveContext(db) {
  assertCredentialOperationAllowed(db);
  const state = readCredentialEncryptionState(db);
  if (state.storage !== "encrypted") return prepareCredentialContext(db, null, { state });
  const recheck = () => {
    assertCredentialOperationAllowed(db);
    if (JSON.stringify(readCredentialEncryptionState(db)) !== JSON.stringify(state))
      throw changed();
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

class RequestScope {
  #db;
  #root;
  #state;
  #signature;
  #at = Date.now();
  #aged = false;
  #dead = false;
  #flight = null;
  #slots = new Map();
  handle;

  constructor({ db, root = null, state = null, markers }) {
    this.#db = db;
    // No caller-owned buffer aliases the retained root.
    this.#root = root ? { kid: root.kid, key: Buffer.from(root.key) } : null;
    this.#state = state ? { ...state } : null;
    this.#signature = markers ? JSON.stringify(markers) : signature(db);
    const self = this;
    this.handle = Object.freeze({
      memo: (key, loader) => self.#memo(key, loader),
      get expired() {
        return self.expired;
      },
    });
    Object.freeze(this);
  }

  #wipe() {
    if (this.#root) zeroBuffer(this.#root.key);
    this.#root = null;
    this.#slots.clear();
  }

  get expired() {
    if (Date.now() - this.#at < DEK_CACHE_TTL_MS && !this.#aged) return false;
    this.#wipe();
    this.#state = null;
    this.#aged = true;
    return true;
  }

  #check(db) {
    assertCredentialOperationAllowed(db);
    if (this.#dead) throw changed();
    if (signature(db) !== this.#signature) {
      this.#dead = true;
      this.#wipe();
      throw changed();
    }
  }

  matches(db) {
    if (this.#dead) throw changed();
    return (!db || db === this.#db) && !this.expired;
  }

  async decode(db, rows, table) {
    let ctx;
    if (!this.matches(db)) ctx = await liveContext(db);
    else {
      this.#check(db);
      this.#state ??= readCredentialEncryptionState(db);
      if (this.#state.storage === "encrypted" && !this.#root) {
        this.#flight ??= loadMasterKey({ expectedKid: this.#state.kekKid });
        try {
          const root = await this.#flight;
          this.#check(db);
          this.#root = { kid: root.kid, key: Buffer.from(root.key) };
        } catch (error) {
          this.#check(db);
          throw error;
        } finally {
          this.#flight = null;
        }
      }
      ctx = prepareCredentialContext(db, this.#root, { state: this.#state });
    }
    // Context never escapes this module; no consumer can mutate/zero its KEK.
    return rows.map((row) => decodeCredentialRowSync(db, row, ctx, { table }));
  }

  // Every access (warm or cold) proves poison + current markers first, and the
  // value is only handed out after the same proof post-await. Mismatch is sticky
  // (scope dead, slots wiped) and never falls back to live state. Aged scopes
  // read live, but still honor poison.
  async #memo(key, loader) {
    const db = this.#db;
    if (this.#dead) throw changed();
    if (this.expired) {
      assertCredentialOperationAllowed(db);
      return loader();
    }
    this.#check(db);
    let slot = this.#slots.get(key);
    if (!slot) {
      slot = (async () => {
        let value;
        try {
          value = await loader();
        } catch (error) {
          this.#check(db);
          throw error;
        }
        this.#check(db);
        return value;
      })();
      this.#slots.set(key, slot);
      slot.catch(() => {
        if (this.#slots.get(key) === slot) this.#slots.delete(key);
      });
    }
    const value = await slot;
    this.#check(db);
    return value;
  }
}

/**
 * Server-only mint: the only way to obtain a scoped principal. `seed` (root,
 * state, markers from the hash-key load) is copied, never retained by reference.
 * Scope identity is the minted object itself, so frozen copies/spreads have none.
 */
export function mintGatewayPrincipal(fields, db, seed = null) {
  if (Object.isFrozen(fields)) throw new Error("Principal fields required, not a frozen principal");
  const principal = Object.freeze({
    ...fields,
    scopes: Object.freeze({
      allowedModels: Object.freeze([...fields.scopes.allowedModels]),
      allowedCombos: Object.freeze([...fields.scopes.allowedCombos]),
    }),
  });
  scopes.set(principal, new RequestScope({ db, ...seed }));
  return principal;
}

/** Lane P gets memo only. No root-bearing ctx or decode method on this handle. */
export function requestScopeOf(principal, db = null) {
  const scope = scopes.get(principal);
  return scope?.matches(db) ? scope.handle : null;
}

/** Repository operation: return decrypted row data only, never a root/runtime ctx. */
export async function decodeRequestCredentialRows(db, principal, rows, { table }) {
  const scope = scopes.get(principal);
  if (scope) return scope.decode(db, rows, table);
  const ctx = await liveContext(db);
  return rows.map((row) => decodeCredentialRowSync(db, row, ctx, { table }));
}
