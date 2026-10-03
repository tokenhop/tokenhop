// Two-user harness for cross-workspace negative tests (YAN-354). Seeds owner A,
// user B, their personal workspaces and a shared workspace (A owner, B member)
// into the per-file isolated DB, and calls route handlers as A, as B or with a
// gateway key. Usage: tests/README.md "Tenancy isolation tests".
import { NextRequest } from "next/server";

const TENANCY_TABLES = ["memberships", "identities", "workspaces", "users"];

/** Principal (`@/lib/users/principal.js`) for a seeded user. */
function principal(user, workspaceIds) {
  return {
    userId: user.id,
    instanceRole: user.instanceRole,
    workspaceIds,
    activeWorkspaceId: user.personalWorkspaceId,
    via: "session",
  };
}

/**
 * Wipe the tenancy tables of this file's isolated DB and seed A and B.
 * @returns {Promise<{ a: Seeded, b: Seeded, shared: object }>}
 * @typedef {{ user: object, ctx: object, personal: string }} Seeded
 */
export async function seedTenancy() {
  const db = await import("@/lib/db/index.js");
  const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  for (const t of TENANCY_TABLES) adapter.run(`DELETE FROM ${t}`);

  const ua = await db.createUserUnscoped({ email: "a@tenancy.test", instanceRole: "owner" });
  const ub = await db.createUserUnscoped({ email: "b@tenancy.test", instanceRole: "user" });
  const shared = await db.createSharedWorkspace(principal(ua, []), { name: "Shared" });
  await db.addMembership(principal(ua, []), shared.id, { userId: ub.id, role: "member" });

  const seeded = (u) => ({
    user: u,
    ctx: principal(u, [u.personalWorkspaceId, shared.id]),
    personal: u.personalWorkspaceId,
  });
  return { a: seeded(ua), b: seeded(ub), shared };
}

/**
 * Call a route handler as a seeded user (session cookie with the ADR-0004
 * claims) or with a gateway key.
 * @param {Function} handler e.g. `GET` from `@/app/api/.../route.js`
 * @param {string} path e.g. "/api/keys"
 * @param {{ as?: Seeded, apiKey?: string, method?: string, body?: unknown, params?: object }} [opts]
 */
export async function callRoute(handler, path, { as, apiKey, method = "GET", body, params } = {}) {
  const headers = new Headers();
  if (as) {
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    const token = await createDashboardAuthToken({
      sub: as.user.id,
      sv: as.user.sessionVersion,
      wid: as.ctx.activeWorkspaceId,
    });
    headers.set("cookie", `auth_token=${token}`);
  }
  if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  const req = new NextRequest(new URL(path, "http://localhost"), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handler(req, { params: Promise.resolve(params ?? {}) });
}

/**
 * True when a scoped call refused: resolved null/false, or threw a
 * TenancyError NOT_FOUND / FORBIDDEN. Any other error is rethrown. For lists,
 * assert the other user's ids are absent instead.
 */
export async function denied(call) {
  try {
    const out = await (typeof call === "function" ? call() : call);
    return out === null || out === false;
  } catch (err) {
    if (err?.name === "TenancyError" && ["NOT_FOUND", "FORBIDDEN"].includes(err.code)) return true;
    throw err;
  }
}
