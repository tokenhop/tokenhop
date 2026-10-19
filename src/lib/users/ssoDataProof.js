// YAN-1012: one-time data-transfer proof consumption. Kept free of IdP/protocol
// imports so the transfer routes can use it without loading the SSO flow.
import { TenancyError } from "./errors.js";
import { DATA_TRANSFER_PURPOSES, takeProofSlot } from "./ssoProofState.js";

/**
 * Take (burn, even on mismatch) a minted data-transfer proof and bind it to the
 * purpose, actor, workspace (null for instance actions) and sv. TTL is
 * inherited from the slot, never extended.
 * @throws {TenancyError} REAUTH_REQUIRED
 */
export function consumeDataTransferProof(ssoProof, { purpose, actorId, workspaceId = null, sv }) {
  const slot = typeof ssoProof === "string" ? takeProofSlot(ssoProof) : null;
  if (
    slot?.stage !== "action_proof" ||
    !Object.values(DATA_TRANSFER_PURPOSES).includes(purpose) ||
    slot.purpose !== purpose ||
    slot.actorId !== actorId ||
    (slot.workspaceId ?? null) !== (workspaceId ?? null) ||
    slot.sv !== sv
  )
    throw new TenancyError("REAUTH_REQUIRED", "Fresh authentication required");
  return slot;
}
