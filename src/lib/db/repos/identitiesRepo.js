// Login identities (YAN-353, ADR-0003): UNIQUE (provider, issuer, subject).
// Linked by stable identifiers only, never by email.
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { TenancyError, assertCtx, mapConstraintErrors } from "@/lib/users/errors.js";

const COLS = "id, userId, provider, issuer, subject, emailAtLink, createdAt, lastLoginAt";

export async function listIdentities(ctx) {
  assertCtx(ctx);
  const db = await getAdapter();
  return db.all(`SELECT ${COLS} FROM identities WHERE userId = ? ORDER BY createdAt ASC`, [
    ctx.userId,
  ]);
}

export async function unlinkIdentity(ctx, id) {
  assertCtx(ctx);
  const db = await getAdapter();
  return db.run(`DELETE FROM identities WHERE id = ? AND userId = ?`, [id, ctx.userId]).changes > 0;
}

/**
 * YAN-371: unlink one of the caller's SSO identities, refusing to remove the
 * last usable sign-in method. Check and delete run in one transaction so two
 * parallel unlinks can't both pass the check.
 * @param {object} ctx principal (userId)
 * @param {string} id identity id
 * @param {{ sso: Set<string>, password: boolean }} usable SSO providers that
 *   may sign in now, and whether the user can sign in with a password.
 * @returns {Promise<string>} the unlinked identity's provider
 * @throws {TenancyError} NOT_FOUND (not the caller's), INVALID (password row),
 *   LAST_METHOD (nothing usable would remain)
 */
export async function unlinkSsoIdentityGuarded(ctx, id, usable) {
  assertCtx(ctx);
  const db = await getAdapter();
  return db.transaction(() => {
    const row = db.get(`SELECT id, provider FROM identities WHERE id = ? AND userId = ?`, [
      id,
      ctx.userId,
    ]);
    if (!row) throw new TenancyError("NOT_FOUND", "Identity not found");
    if (row.provider === "password") {
      throw new TenancyError("INVALID", "The password sign-in can't be unlinked");
    }
    const others = db
      .all(`SELECT provider FROM identities WHERE userId = ? AND id <> ?`, [ctx.userId, id])
      .filter((r) => usable.sso.has(r.provider)).length;
    if (!usable.password && others === 0) {
      throw new TenancyError("LAST_METHOD", "This is your last way to sign in");
    }
    db.run(`DELETE FROM identities WHERE id = ? AND userId = ?`, [id, ctx.userId]);
    return row.provider;
  });
}

// Login/bootstrap path: resolve an identity before any principal exists.
export async function findIdentityUnscoped({ provider, issuer = "", subject }) {
  const db = await getAdapter();
  return (
    db.get(`SELECT ${COLS} FROM identities WHERE provider = ? AND issuer = ? AND subject = ?`, [
      provider,
      issuer,
      subject,
    ]) ?? null
  );
}

// Bootstrap path: every identity of one user, before any principal exists.
export async function listIdentitiesUnscoped(userId) {
  const db = await getAdapter();
  return db.all(`SELECT ${COLS} FROM identities WHERE userId = ? ORDER BY createdAt ASC`, [userId]);
}

/**
 * Synchronous identity insert for caller-owned transactions (no await). Throws
 * TenancyError on bad subject and maps UNIQUE failures (IDENTITY_TAKEN).
 * Shared by linkIdentityUnscoped.
 */
export function insertIdentitySync(db, userId, { provider, issuer = "", subject, emailAtLink }) {
  if (typeof subject !== "string" || !subject) {
    throw new TenancyError("INVALID", "Identity subject is required");
  }
  const identity = {
    id: uuidv4(),
    userId,
    provider,
    issuer: issuer ?? "",
    subject,
    emailAtLink: emailAtLink ?? null,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };
  mapConstraintErrors(() =>
    db.run(
      `INSERT INTO identities(id, userId, provider, issuer, subject, emailAtLink, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [
        identity.id,
        userId,
        provider,
        identity.issuer,
        subject,
        identity.emailAtLink,
        identity.createdAt,
      ],
    ),
  );
  return identity;
}

// Login/bootstrap/admin path. Callers decide who the identity belongs to.
export async function linkIdentityUnscoped(userId, key) {
  return insertIdentitySync(await getAdapter(), userId, key);
}
