// YAN-360: password re-auth proof for instance ownership transfer. The live
// browser session is never proof on its own: the owner re-proves their current
// password in the same request, bound to their live sessionVersion and the
// target, before the repo swaps the single owner row.
import { verifyPassword } from "@/lib/auth/userPassword.js";
import {
  getUserPasswordHashUnscoped,
  getUserUnscoped,
  transferOwnership,
} from "@/lib/db/repos/usersRepo.js";
import { TenancyError } from "./errors.js";

// bcrypt silently truncates past 72 bytes; a real password could never be set
// longer (validateNewPassword rejects it), so over-cap proofs fail closed.
const MAX_PROOF_BYTES = 72;

/**
 * Verify the actor's current password, then run the repo transfer with the
 * proof bound to the actor's live sessionVersion.
 * @param {{ actorUserId: string, toUserId: string, currentPassword: unknown, expectedSessionVersion?: number }} p
 */
export async function transferWithPasswordProof({
  actorUserId,
  toUserId,
  currentPassword,
  expectedSessionVersion,
}) {
  // The session's sv is mandatory proof binding: no verified sv, no transfer.
  if (!Number.isInteger(expectedSessionVersion)) {
    throw new TenancyError("STALE", "Session is out of date");
  }
  const actor = await getUserUnscoped(actorUserId);
  const pw = typeof currentPassword === "string" ? currentPassword : "";
  if (!actor) {
    // Dummy-hash cover: unknown actors cost the same as a wrong password.
    await verifyPassword(pw, null);
    throw new TenancyError("NOT_FOUND", "User not found");
  }
  if (actor.instanceRole !== "owner" || actor.status !== "active") {
    throw new TenancyError("FORBIDDEN", "Only the active instance owner can transfer ownership");
  }
  if (actor.sessionVersion !== expectedSessionVersion) {
    throw new TenancyError("STALE", "Session is out of date");
  }
  const hash = await getUserPasswordHashUnscoped(actor.id);
  if (hash == null) {
    // SSO-only owner: no password to verify against. Fail closed (follow-up
    // issue tracks an SSO fresh re-auth challenge).
    throw new TenancyError(
      "REAUTH_UNSUPPORTED",
      "This owner signs in with single sign-on, so password transfer is unavailable",
    );
  }
  if (!pw || Buffer.byteLength(pw, "utf8") > MAX_PROOF_BYTES) {
    await verifyPassword(pw, null); // dummy-hash timing; never a valid proof

    throw new TenancyError("REAUTH_REQUIRED", "Invalid current password");
  }
  if (!(await verifyPassword(pw, hash))) {
    throw new TenancyError("REAUTH_REQUIRED", "Invalid current password");
  }
  return transferOwnership(
    { userId: actor.id },
    toUserId,
    // Re-checked in the swap transaction: a change during bcrypt voids it.
    { expectedSessionVersion },
  );
}
