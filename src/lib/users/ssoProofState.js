// ponytail: bounded, ephemeral single-process slots; use shared storage if replicated.
// Drafts, verified groups, linked identities and PKCE secrets never enter cookies.
import { randomBytes } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { deriveSecretKey } from "@/lib/auth/dashboardSession.js";
import { TenancyError } from "./errors.js";

export const SSO_PROOF_COOKIE = "sso_proof_state";
export const SSO_PREVIEW_PURPOSE = "sso_preview";
export const WORKSPACE_DELETE_PURPOSE = "workspace_delete";
export const PROOF_FLOW_PREFIX = "sso-proof:";
// YAN-1012: one purpose per data-transfer action, so purpose equality blocks
// cross-action replay.
export const DATA_TRANSFER_PURPOSES = Object.freeze({
  "instance.export": "data_instance_export",
  "instance.import": "data_instance_import",
  "workspace.export": "data_workspace_export",
  "workspace.import": "data_workspace_import",
});
const PURPOSES = [
  SSO_PREVIEW_PURPOSE,
  WORKSPACE_DELETE_PURPOSE,
  ...Object.values(DATA_TRANSFER_PURPOSES),
];
// Parked on globalThis (saml.js __tokenhopSamlRequestCache precedent) so
// duplicate module instances (dev HMR) share one store. Still bounded and
// single-process: use shared storage keyed by ref if ever replicated.
if (!globalThis.__tokenhopSsoProofSlots) {
  globalThis.__tokenhopSsoProofSlots = new Map();
}
const slots = globalThis.__tokenhopSsoProofSlots;
const TTL = 300_000;
const MAX = 512;
// Per-actor ceiling on live slots, so one user cannot exhaust the global store.
const MAX_PER_ACTOR = 5;

function sweep(now) {
  for (const [id, slot] of slots) if (slot.expiresAt <= now) slots.delete(id);
}

export function putProofSlot(slot, now = Date.now()) {
  sweep(now);
  if (slot.actorId) {
    let live = 0;
    for (const s of slots.values()) if (s.actorId === slot.actorId) live++;
    if (live >= MAX_PER_ACTOR) throw new TenancyError("PROOF_RATE_LIMITED", "Too many attempts");
  }
  if (slots.size >= MAX) throw new TenancyError("PROOF_CAPACITY", "Service unavailable");
  const ref = randomBytes(32).toString("base64url");
  // Handoffs never extend freshness: draft, result and deletion share one TTL.
  slots.set(ref, { ...slot, expiresAt: Math.min(slot.expiresAt ?? now + TTL, now + TTL) });
  return ref;
}

export function peekProofSlot(ref, now = Date.now()) {
  sweep(now);
  return slots.get(ref) ?? null;
}

export function takeProofSlot(ref, now = Date.now()) {
  const slot = peekProofSlot(ref, now);
  slots.delete(ref);
  return slot;
}

export function resetProofSlots() {
  slots.clear();
}

export async function sealSsoProofState({ ref, purpose, actorId, sv, provider, flow }) {
  if (
    !ref ||
    !PURPOSES.includes(purpose) ||
    !actorId ||
    !Number.isInteger(sv) ||
    !["oidc", "saml"].includes(provider) ||
    !flow?.startsWith(PROOF_FLOW_PREFIX)
  ) {
    throw new TenancyError("INVALID", "Invalid proof state");
  }
  return new EncryptJWT({ ref, purpose, actorId, sv, provider, flow })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .encrypt(deriveSecretKey("sso-proof"));
}

export async function openSsoProofState(sealed) {
  try {
    const { payload: p } = await jwtDecrypt(sealed, deriveSecretKey("sso-proof"), {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    if (
      typeof p.ref !== "string" ||
      !PURPOSES.includes(p.purpose) ||
      typeof p.actorId !== "string" ||
      !Number.isInteger(p.sv) ||
      !["oidc", "saml"].includes(p.provider) ||
      typeof p.flow !== "string" ||
      !p.flow.startsWith(PROOF_FLOW_PREFIX)
    )
      return null;
    return p;
  } catch {
    return null;
  }
}

export function assertSlotBinding(slot, state, stage) {
  if (
    !slot ||
    slot.stage !== stage ||
    slot.purpose !== state.purpose ||
    slot.actorId !== state.actorId ||
    slot.sv !== state.sv ||
    slot.provider !== state.provider ||
    slot.flow !== state.flow
  ) {
    throw new TenancyError("REAUTH_REQUIRED", "Fresh authentication required");
  }
}

// Verified protocol claims only. Role and sv are re-read again at final use.
export function assertFreshIdentity(
  slot,
  { issuer, subject, authenticatedAtMs },
  now = Date.now(),
) {
  if (issuer !== slot.issuer || subject !== slot.subject || !issuer || !subject) {
    throw new TenancyError("FORBIDDEN", "Forbidden");
  }
  if (
    !Number.isFinite(authenticatedAtMs) ||
    authenticatedAtMs < slot.startedAt - 60_000 ||
    authenticatedAtMs > now + 60_000 ||
    now - authenticatedAtMs > TTL
  ) {
    throw new TenancyError("STALE", "Fresh authentication required");
  }
}
