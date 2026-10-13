import { statsEmitter, getLiveSnapshot } from "@/lib/usageDb";
import { countActiveUsersUnscoped } from "@/lib/db/index.js";
import { getAdapter } from "@/lib/db/driver.js";
import { buildLivePayload } from "@/lib/usage/livePayload";
import { historicalKey, liveMember, usageScope } from "@/lib/usage/scope.js";
import { isMultiUserEnabled } from "@/lib/users/featureSwitch.js";
import { can } from "@/lib/users/principal.js";
import { resolvePrincipal } from "@/lib/users/session.js";

export const dynamic = "force-dynamic";

// A workspace manager/owner or instance owner/admin may widen the view
// (workspace-wide, other users, other keys); everyone else sees only self.
const widens = (ctx, workspaceId) =>
  ["owner", "manager"].includes(ctx.workspaceRoles?.[workspaceId]) ||
  ["owner", "admin"].includes(ctx.instanceRole);

// YAN-407 stream diet: one slim frame per event (connect, "update", "pending"),
// built from the in-memory snapshot — the full-history stats aggregate is never
// computed here. Cleanup runs on send failure, cancel and request abort.
// YAN-378: the connect-time scope is re-validated against the live session and
// membership before every data frame (and on every keepalive tick), so a
// revoked session, removed member or downgraded role stops the stream.
export async function GET(request) {
  const scope = await usageScope(request);
  if (scope instanceof Response) return scope;
  const liveScope = scope
    ? { workspaceId: scope.workspaceId, userId: scope.userId, apiKeyId: scope.apiKeyId }
    : null;

  // Emitter and timer callbacks run outside the request context, so re-resolve
  // from the captured request (cookies/headers), never from next/headers.
  // Target users must stay live members. Historical key attribution remains
  // valid after revocation/pause/expiry; only workspace/ownership changes or
  // deletion invalidate that filter, matching usageScope on reconnect.
  const stillAllowed = async () => {
    const multi = (await isMultiUserEnabled()) && (await countActiveUsersUnscoped()) > 1;
    if (!scope) return !multi; // unscoped connect: stop once scoping turns on
    if (!multi) return false;
    const ctx = await resolvePrincipal(request);
    if (!ctx || ctx.userId !== scope.ctx.userId) return false;
    if (!can(ctx, "workspace.usage.read", { workspaceId: scope.workspaceId })) return false;
    if (widens(scope.ctx, scope.workspaceId) && !widens(ctx, scope.workspaceId)) return false;
    const db = await getAdapter();
    if (scope.userId && scope.userId !== ctx.userId) {
      if (!liveMember(db, scope.workspaceId, scope.userId)) return false;
    }
    if (scope.apiKeyId) {
      // Historical attribution: pause/expiry/revocation do not end the stream
      // (revocation affects routing, not past usage). Only a deleted or moved
      // key — or a member losing the own-key entitlement — closes it.
      const key = historicalKey(db, scope.workspaceId, scope.apiKeyId);
      if (!key) return false;
      if (!widens(ctx, scope.workspaceId) && key.userId !== ctx.userId) return false;
    }
    return true;
  };

  const encoder = new TextEncoder();
  const state = {
    closed: false,
    clientCancelled: false,
    keepalive: null,
    send: null,
    stalled: 0,
    controller: null,
  };

  const cleanup = () => {
    if (state.closed) return;
    state.closed = true;
    if (state.send) {
      statsEmitter.off("update", state.send);
      statsEmitter.off("pending", state.send);
    }
    clearInterval(state.keepalive);
    request.signal.removeEventListener("abort", cleanup);
    try {
      // Client-cancel close is already torn down by cancel(); closing again
      // throws, so only close here for server-side cleanup.
      if (!state.clientCancelled) state.controller?.close();
    } catch {}
  };

  const stream = new ReadableStream({
    async start(controller) {
      state.controller = controller;
      // Listen before the first await so an already-aborted or racing abort
      // never leaves a subscriber behind.
      if (request.signal.aborted) return cleanup();
      request.signal.addEventListener("abort", cleanup);

      state.send = async () => {
        if (state.closed) return;
        try {
          const payload = buildLivePayload(await getLiveSnapshot(liveScope));
          // Last await before enqueue: nothing from a lost scope is emitted.
          const allowed = await stillAllowed();
          if (state.closed) return;
          if (!allowed) return cleanup();
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            if (++state.stalled >= 3) return cleanup();
          } else {
            state.stalled = 0;
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          cleanup();
        }
      };

      // One frame on connect so a fresh client paints live fields immediately.
      await state.send();
      if (state.closed) return;

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.send);

      state.keepalive = setInterval(async () => {
        if (state.closed) return clearInterval(state.keepalive);
        try {
          const allowed = await stillAllowed();
          if (state.closed) return;
          if (!allowed) return cleanup();
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 25000);
    },

    cancel() {
      state.clientCancelled = true;
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
