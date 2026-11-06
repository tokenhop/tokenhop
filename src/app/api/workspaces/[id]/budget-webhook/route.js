// YAN-1831: the workspace budget webhook (one optional URL per workspace).
// GET reads, PUT creates or updates (and rotates the signing secret), DELETE
// removes. Browser session only; the repo re-checks live budget authority
// (`workspace.budgets.lower`) inside its transaction and writes the audit
// row. Switch off: `[id]` is `default` or the resolved budget workspace and
// the off-mode admin manages it (see budgetsRepo offAccess). The signing
// secret is returned only by the write that minted it. Fixed error text only.
import { json, PayloadTooLarge } from "@/lib/users/userManagement.js";
import { badRequest, gate, readBody } from "@/lib/users/budgetRoutes.js";
import {
  deleteBudgetWebhook,
  getBudgetWebhook,
  saveBudgetWebhook,
} from "@/lib/db/repos/budgetWebhooksRepo.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const KEYS = ["url", "enabled", "rotateSecret"];

const ERRORS = {
  INVALID: [400, "Invalid request", "invalid_request"],
  INVALID_URL: [400, "Webhook URL is not valid", "invalid_url"],
  BLOCKED_DESTINATION: [400, "Webhook destination is not allowed", "blocked_destination"],
  NOT_FOUND: [404, "Budget webhook not found", "not_found"],
  FORBIDDEN: [403, "Forbidden", "forbidden"],
  KEY_MISSING: [503, "The credential root key is unavailable", "key_missing"],
  MASTER_KEY_INVALID: [503, "The credential root key is unavailable", "key_missing"],
  KEY_MISMATCH: [503, "The credential root key does not match this instance", "key_mismatch"],
  CREDENTIAL_STATE_INVALID: [503, "Credential encryption state is unavailable", "state_invalid"],
  CREDENTIAL_MAINTENANCE_POISONED: [409, "Credential maintenance is locked", "locked"],
};

function fail(err) {
  if (err instanceof PayloadTooLarge)
    return json({ error: err.message, code: err.code }, err.status);
  const hit = ERRORS[err?.code];
  if (hit) return json({ error: hit[1], code: hit[2] }, hit[0]);
  if (err?.code === "API_KEY_STATE_INVALID") return json({ error: "Service unavailable" }, 503);
  return json({ error: "Internal error" }, 500);
}

export async function GET(request, { params }) {
  const g = await gate(request, { offAllowed: true });
  if (g.res) return g.res;
  try {
    const { id } = await params;
    return json(await getBudgetWebhook(g.principal, { workspaceId: id }));
  } catch (err) {
    return fail(err);
  }
}

export async function PUT(request, { params }) {
  const g = await gate(request, { body: true, offAllowed: true });
  if (g.res) return g.res;
  try {
    const { id } = await params;
    const body = await readBody(request, KEYS);
    if (!body || Object.keys(body).length === 0) return badRequest();
    const { webhook, secret, created } = await saveBudgetWebhook(
      g.principal,
      { ...body, workspaceId: id },
      { request },
    );
    return json(secret ? { webhook, secret } : { webhook }, created ? 201 : 200);
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(request, { params }) {
  const g = await gate(request, { offAllowed: true });
  if (g.res) return g.res;
  try {
    const { id } = await params;
    await deleteBudgetWebhook(g.principal, { workspaceId: id }, { request });
    return json({ webhook: null });
  } catch (err) {
    return fail(err);
  }
}
