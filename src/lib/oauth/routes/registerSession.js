import { NextResponse } from "next/server";
import {
  registerTraeSession,
  registerWindsurfSession,
  registerZedSession,
  getTraeSessionStatus,
  getWindsurfSessionStatus,
  getZedSessionStatus,
  getXaiSessionStatus,
  getCodexSessionStatus,
} from "@/lib/oauth/utils/server";
import { bindingFor, rememberBinding } from "@/lib/oauth/pendingBinding";
import { hostOnlyRefusal, oauthScope } from "@/lib/oauth/scope";

/** True when `state` is already bound (pending binding or live session) to a different user. */
export function stateOwnedByOther(provider, state, userId) {
  const get = {
    trae: getTraeSessionStatus,
    windsurf: getWindsurfSessionStatus,
    zed: getZedSessionStatus,
    xai: getXaiSessionStatus,
    codex: getCodexSessionStatus,
  }[provider];
  const owner = bindingFor(state) || get?.(state)?.binding;
  return Boolean(owner) && owner.userId !== userId;
}

// POST /api/oauth/[provider]/register-session - bind proxy session to state
export default async function registerSession(provider, request, { searchParams, body }) {
  const refused = await hostOnlyRefusal(request);
  if (refused) return refused;
  const scope = await oauthScope(request);
  if (scope instanceof Response) return scope;

  // Register proxy session out of URL query (state) + body (codeVerifier).
  // Zed's codeVerifier encodes the RSA private key — must stay out of URL/logs.
  const state = searchParams.get("state") || body?.state;
  if (!state) return NextResponse.json({ error: "Missing state" }, { status: 400 });

  // YAN-739: sessions are keyed by state and superseded per user, so concurrent
  // logins from different users coexist on the shared listener.
  const binding = scope
    ? { userId: scope.ctx.userId, workspaceId: scope.workspaceId, ctx: scope.ctx }
    : undefined;
  // A client-chosen state already held by another user is refused (no hijack).
  if (binding && stateOwnedByOther(provider, state, binding.userId)) {
    return NextResponse.json({ error: "State already in use" }, { status: 409 });
  }

  let ok = false;
  if (provider === "trae") ok = registerTraeSession({ state, binding });
  else if (provider === "windsurf") ok = registerWindsurfSession({ state, binding });
  else if (provider === "zed")
    ok = registerZedSession({
      state,
      codeVerifier: body?.codeVerifier,
      systemId: body?.systemId,
      binding,
    });
  else
    return NextResponse.json(
      { error: "register-session only supported for trae/windsurf/zed" },
      { status: 400 },
    );
  if (binding && ok) rememberBinding(state, { provider, ...binding });
  return NextResponse.json({ success: ok });
}
