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

// Login/bootstrap/admin path. Callers decide who the identity belongs to.
export async function linkIdentityUnscoped(
  userId,
  { provider, issuer = "", subject, emailAtLink },
) {
  if (typeof subject !== "string" || !subject) {
    throw new TenancyError("INVALID", "Identity subject is required");
  }
  const db = await getAdapter();
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
