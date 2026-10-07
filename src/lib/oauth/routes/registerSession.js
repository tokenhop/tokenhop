import { NextResponse } from "next/server";
import {
  registerTraeSession,
  registerWindsurfSession,
  registerZedSession,
  otherOwnerActive,
} from "@/lib/oauth/utils/server";
import { rememberBinding } from "@/lib/oauth/pendingBinding";
import { hostOnlyRefusal, oauthScope } from "@/lib/oauth/scope";

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

  // Singleton session: refuse to clobber another principal's pending flow.
  const binding = scope
    ? { userId: scope.ctx.userId, workspaceId: scope.workspaceId, ctx: scope.ctx }
    : undefined;
  if (scope) {
    if (otherOwnerActive(provider, scope.ctx.userId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
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
  if (binding) rememberBinding(state, { provider, ...binding });
  return NextResponse.json({ success: ok });
}
