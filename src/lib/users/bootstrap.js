// Owner bootstrap, SSO owner linking and the one-time setup token (YAN-356,
// ADR-0003/0009). Everything here runs only with the switch on. Never "first
// SSO login wins": an SSO identity links to the owner only through
// TOKENHOP_OWNER_EMAIL (read only here) or a setup token. Tokens are printed
// once at mint and stored as SHA-256 only.
import crypto from "node:crypto";
import {
  bootstrapOwnerUnscoped,
  countActiveUsersUnscoped,
  countSharedWorkspacesUnscoped,
  findIdentityUnscoped,
  getMeta,
  getOwnerUnscoped,
  getSettings,
  linkIdentityUnscoped,
  listIdentitiesUnscoped,
  setMeta,
} from "@/lib/db/index.js";
import { getAdapter } from "@/lib/db/driver.js";
import { makeBackupDir, backupDbLite, pruneOldBackups } from "@/lib/db/backup.js";
import { isMultiUserEnabled } from "./featureSwitch.js";

export const OWNER_EMAIL_ENV = "TOKENHOP_OWNER_EMAIL";
export const SETUP_TOKEN_TTL_MS = 60 * 60 * 1000;
export const SETUP_TOKEN_COOKIE = "setup_token";
const RETRY_MS = 60 * 1000;
const TOKEN_HASH = "ownerSetupTokenHash";
const TOKEN_EXPIRES = "ownerSetupTokenExpiresAt";

// On globalThis: Next bundles the proxy and route handlers separately.
globalThis.__tokenhopOwnerBootstrap ??= { done: false, failedAt: 0, running: null };
const state = globalThis.__tokenhopOwnerBootstrap;

const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest();

// Light check (no oidc/saml imports: this module sits in the proxy bundle).
function ssoConfigured(s) {
  const oidc = s?.oidcIssuerUrl && s?.oidcClientId && s?.oidcClientSecret;
  return Boolean(oidc || (s?.samlEntryPoint && s?.samlCert));
}

/**
 * Mint a setup token (ADR-0003): 256 random bits, single use, 60 minutes.
 * Only its hash is stored; the caller shows the raw token once.
 * @returns {Promise<{ token: string, expiresAt: string }>}
 */
export async function mintSetupToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SETUP_TOKEN_TTL_MS;
  await setMeta(TOKEN_HASH, sha256(token).toString("hex"));
  await setMeta(TOKEN_EXPIRES, expiresAt);
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

const META_GET = "SELECT value FROM _meta WHERE key = ?";

/** Whether an unused, unexpired setup token exists. */
async function liveSetupToken() {
  return Boolean(await getMeta(TOKEN_HASH)) && Number(await getMeta(TOKEN_EXPIRES)) > Date.now();
}

/**
 * Check and burn a presented setup token in one transaction, so two
 * concurrent logins can't both spend it. False on anything but a live match.
 */
export async function consumeSetupToken(token) {
  if (typeof token !== "string" || !token) return false;
  const given = sha256(token);
  const db = await getAdapter();
  return db.transaction(() => {
    const hash = db.get(META_GET, [TOKEN_HASH])?.value;
    if (!hash || !(Number(db.get(META_GET, [TOKEN_EXPIRES])?.value) > Date.now())) return false;
    const stored = Buffer.from(hash, "hex");
    if (stored.length !== given.length || !crypto.timingSafeEqual(stored, given)) return false;
    db.run(`UPDATE _meta SET value = '' WHERE key IN (?, ?)`, [TOKEN_HASH, TOKEN_EXPIRES]);
    return true;
  });
}

// TOKENHOP_OWNER_EMAIL links once: claim it atomically (first insert wins).
async function claimOwnerEmail() {
  const db = await getAdapter();
  const sql = `INSERT INTO _meta(key, value) VALUES('ownerEmailConsumed', '1') ON CONFLICT(key) DO NOTHING`;
  return db.run(sql).changes === 1;
}

// SSO-only setups need a way in for the owner: print a token once at bootstrap
// unless TOKENHOP_OWNER_EMAIL covers it or the owner already has an SSO link.
async function maybePrintSetupToken(owner, settings) {
  if (!ssoConfigured(settings) || process.env[OWNER_EMAIL_ENV]?.trim()) return;
  const ids = await listIdentitiesUnscoped(owner.id);
  if (ids.some((i) => i.provider === "oidc" || i.provider === "saml")) return;
  if (await liveSetupToken()) return;
  const { token, expiresAt } = await mintSetupToken();
  console.log(
    `[users] Owner SSO setup token (single use, expires ${expiresAt}): ${token}\n` +
      "[users] Sign in once via /api/auth/oidc/start?setupToken=<token> (or /api/auth/saml/start?setupToken=<token>) to link your SSO account to the owner. New token: `tokenhop auth setup-token`.",
  );
}

async function runBootstrap() {
  if (await getOwnerUnscoped()) return;
  // Irreversible step (ADR-0009): back up first, abort if that fails.
  backupDbLite(await getAdapter(), makeBackupDir("users-bootstrap"));
  pruneOldBackups();
  const settings = await getSettings();
  let owner;
  try {
    owner = await bootstrapOwnerUnscoped({ passwordHash: settings?.password || null });
  } catch (err) {
    if (err?.code !== "OWNER_EXISTS") throw err;
    return; // another process won the race
  }
  console.log("[users] Bootstrapped the owner and the Default workspace");
  await maybePrintSetupToken(owner, settings);
}

/**
 * Turn a single-user install into owner + "Default" workspace, once, while
 * the switch is on. Idempotent: an existing owner means done. Memoised per
 * process; a failure is logged and retried after a minute (each retry takes
 * a fresh backup, so never in a tight loop).
 */
export async function ensureOwnerBootstrap() {
  if (state.done || Date.now() - state.failedAt < RETRY_MS) return;
  state.running ??= isMultiUserEnabled()
    .then((on) => on && runBootstrap().then(() => true))
    .then((ran) => {
      if (ran) state.done = true;
    })
    .catch((err) => {
      state.failedAt = Date.now();
      console.warn("[users] Owner bootstrap failed, retrying later:", err?.message || err);
    })
    .finally(() => {
      state.running = null;
    });
  await state.running;
}

/**
 * The user an SSO login acts as, or null when it isn't linked. Linked
 * identity → its user. Otherwise link to the owner only when the verified
 * email matches TOKENHOP_OWNER_EMAIL (one shot) or `setupToken` is valid.
 * @param {{ provider: "oidc"|"saml", issuer?: string, subject: string, email?: string, emailVerified?: boolean }|null} identity
 * @param {{ setupToken?: string }} [opts]
 * @returns {Promise<string|null>} user id
 */
export async function resolveSsoUser(identity, { setupToken } = {}) {
  if (!identity?.subject || !(await isMultiUserEnabled())) return null;
  const key = {
    provider: identity.provider,
    issuer: identity.issuer || "",
    subject: identity.subject,
  };
  const linked = await findIdentityUnscoped(key);
  if (linked) return linked.userId;

  const owner = await getOwnerUnscoped();
  if (owner?.status !== "active") return null;
  const email = String(identity.email || "")
    .trim()
    .toLowerCase();
  const ownerEmail = String(process.env[OWNER_EMAIL_ENV] || "")
    .trim()
    .toLowerCase();
  const emailMatch = ownerEmail && identity.emailVerified === true && email === ownerEmail;
  // ponytail: the claim is spent even if linking then fails; mint a setup token to retry.
  const byEmail = emailMatch && (await claimOwnerEmail());
  if (!byEmail && !(await consumeSetupToken(setupToken))) return null;

  try {
    await linkIdentityUnscoped(owner.id, { ...key, emailAtLink: email || null });
  } catch (err) {
    if (err?.code !== "IDENTITY_TAKEN") throw err;
    return (await findIdentityUnscoped(key))?.userId ?? null;
  }
  console.log(`[users] Linked ${key.provider} identity to the owner`);
  return owner.id;
}

/**
 * SSO start routes: carry `?setupToken=` to the callback in a short-lived
 * httpOnly cookie. Switch off: ignored.
 */
export async function stashSetupToken(request, cookieStore, options) {
  const token = new URL(request.url).searchParams.get("setupToken");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token || "") || !(await isMultiUserEnabled())) return;
  cookieStore.set(SETUP_TOKEN_COOKIE, token, options);
}

/** SSO callbacks: read and clear the stashed setup token. */
export function takeSetupToken(cookieStore) {
  const token = cookieStore.get(SETUP_TOKEN_COOKIE)?.value;
  if (token) cookieStore.delete(SETUP_TOKEN_COOKIE);
  return token || undefined;
}

/**
 * UI gate (ADR-0009): true once a second active user or a second shared
 * workspace exists, so single-user installs keep today's look.
 * @returns {Promise<boolean>}
 */
export async function multiUserActive() {
  if (!(await isMultiUserEnabled())) return false;
  return (await countActiveUsersUnscoped()) >= 2 || (await countSharedWorkspacesUnscoped()) >= 2;
}
