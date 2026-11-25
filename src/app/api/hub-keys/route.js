// YAN-2019: usage hub management keys (T3 Code reads). GET lists active keys
// (prefix and metadata only), POST mints one and returns the raw key once.
// Owner/admin only; hidden while TOKENHOP_USAGE_HUB is off (hubKeyRoutes.js).
import { json, PayloadTooLarge, readJsonBody } from "@/lib/users/userManagement.js";
import { audit } from "@/lib/users/audit.js";
import { createHubKeyUnscoped, listHubKeysUnscoped } from "@/lib/db/repos/hubKeysRepo.js";
import { hubKeyGate, resyncPoller } from "@/lib/hub/hubKeyRoutes.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_BODY = 1024;

export async function GET(request) {
  const g = await hubKeyGate(request);
  if (g.res) return g.res;
  try {
    return json({ keys: await listHubKeysUnscoped() });
  } catch {
    return json({ error: "Internal error" }, 500);
  }
}

export async function POST(request) {
  const g = await hubKeyGate(request, { body: true });
  if (g.res) return g.res;
  let body;
  try {
    body = await readJsonBody(request, { max: MAX_BODY });
  } catch (err) {
    if (err instanceof PayloadTooLarge)
      return json({ error: "Payload too large", code: "payload_too_large" }, 413);
    return json({ error: "Internal error" }, 500);
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => k !== "name")
  ) {
    return json({ error: "Invalid request", code: "invalid_request" }, 400);
  }
  try {
    const { key, metadata } = await createHubKeyUnscoped({
      name: body.name ?? null,
      createdByUserId: g.principal?.userId ?? null,
    });
    await audit(
      { principal: g.principal, request },
      "hubKey.create",
      { type: "hubKey", id: metadata.id },
      { after: { id: metadata.id, name: metadata.name, keyPrefix: metadata.prefix } },
    );
    resyncPoller();
    return json({ key, metadata }, 201);
  } catch (err) {
    if (err?.code === "INVALID")
      return json({ error: "Invalid request", code: "invalid_request" }, 400);
    if (err?.code === "LIMIT")
      return json({ error: "Too many active hub keys", code: "limit_reached" }, 409);
    return json({ error: "Internal error" }, 500);
  }
}
