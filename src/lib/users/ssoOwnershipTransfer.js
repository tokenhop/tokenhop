// SSO fresh re-auth proof for instance ownership transfer. Completes the
// sealed state flow from auth/ownershipTransferState.js: the owner proved a
// live IdP authentication (OIDC or SAML) bound to the state opened from the
// cookie, then the repo swaps the single owner row. Never creates a session
// and never admits via ssoAdmit: this is a re-auth gate only.
import { findIdentityUnscoped } from "@/lib/db/repos/identitiesRepo.js";
import { transferOwnership } from "@/lib/db/repos/usersRepo.js";
import { TenancyError } from "./errors.js";
import { isMultiUserEnabled } from "./featureSwitch.js";

const PROVIDERS = ["oidc", "saml"];
const SKEW_MS = 60_000;
const FRESH_MS = 300_000;

const str = (v) => typeof v === "string" && v !== "";

/**
 * Complete an SSO ownership transfer after the IdP callback verified the
 * owner's fresh authentication.
 * @param {{ state: object, provider: string, issuer: string, subject: string, authenticatedAtMs: number, now?: number }}
 */
export async function completeSsoOwnershipTransfer({
  state,
  provider,
  issuer,
  subject,
  authenticatedAtMs,
  now = Date.now(),
}) {
  if (
    !state ||
    typeof state !== "object" ||
    !str(state.ownerId) ||
    !Number.isInteger(state.sessionVersion) ||
    !str(state.toUserId) ||
    !PROVIDERS.includes(state.provider) ||
    !str(state.issuer) ||
    !str(state.subject) ||
    !Number.isFinite(state.startedAt)
  ) {
    throw new TenancyError("FORBIDDEN", "Only the instance owner can transfer ownership");
  }
  if (provider !== state.provider || !PROVIDERS.includes(provider)) {
    throw new TenancyError("FORBIDDEN", "Only the instance owner can transfer ownership");
  }
  if (issuer !== state.issuer || subject !== state.subject) {
    throw new TenancyError("FORBIDDEN", "Only the instance owner can transfer ownership");
  }
  const t = Number.isFinite(now) ? now : Date.now();
  if (
    !Number.isFinite(authenticatedAtMs) ||
    authenticatedAtMs < state.startedAt - SKEW_MS ||
    authenticatedAtMs > t + SKEW_MS ||
    t - authenticatedAtMs > FRESH_MS
  ) {
    throw new TenancyError("STALE", "Session is out of date");
  }
  if (!(await isMultiUserEnabled())) {
    throw new TenancyError("FORBIDDEN", "Only the instance owner can transfer ownership");
  }
  const identity = await findIdentityUnscoped({ provider, issuer, subject });
  if (!identity || identity.userId !== state.ownerId) {
    throw new TenancyError("FORBIDDEN", "Only the instance owner can transfer ownership");
  }
  let next;
  try {
    next = await transferOwnership({ userId: state.ownerId }, state.toUserId, {
      expectedSessionVersion: state.sessionVersion,
    });
  } catch (err) {
    if (err?.code === "STALE") throw err;
    if (err instanceof TenancyError) {
      throw new TenancyError("FORBIDDEN", "Only the instance owner can transfer ownership");
    }
    throw err;
  }
  const { sessionVersion: _sv, ...safe } = next;
  return safe;
}
