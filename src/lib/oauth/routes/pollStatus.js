import { NextResponse } from "next/server";
import {
  stopXiaomiMimoProxy,
  getTraeSessionStatus,
  clearTraeSession,
  getWindsurfSessionStatus,
  clearWindsurfSession,
  getZedSessionStatus,
  clearZedSession,
  getXaiSessionStatus,
  clearXaiSession,
  getCodexSessionStatus,
  clearCodexSession,
  getXiaomiMimoSessionStatus,
  clearXiaomiMimoSession,
} from "@/lib/oauth/utils/server";
import { bindingFor, forgetBinding, ownerMatches } from "@/lib/oauth/pendingBinding";
import { oauthScope } from "@/lib/oauth/scope";

// GET /api/oauth/[provider]/poll-status?state=… - loopback session status
export default async function pollStatus(provider, request, { searchParams }) {
  const state = searchParams.get("state");
  if (!state) {
    return NextResponse.json({ error: "Missing state" }, { status: 400 });
  }
  let session;
  if (provider === "trae") session = getTraeSessionStatus(state);
  else if (provider === "windsurf") session = getWindsurfSessionStatus(state);
  else if (provider === "zed") session = getZedSessionStatus(state);
  else if (provider === "xai") session = getXaiSessionStatus(state);
  else if (provider === "codex") session = getCodexSessionStatus(state);
  else if (provider === "xiaomi-mimo") session = getXiaomiMimoSessionStatus(state);
  else
    return NextResponse.json(
      { error: "Poll only supported for codex/xai/trae/windsurf/zed/xiaomi-mimo" },
      { status: 400 },
    );
  if (!session) return NextResponse.json({ status: "unknown" });

  // Owner check: only the principal that started the flow reads its session
  // (the payload carries codeVerifier/redirectUri for codex/xai).
  const scope = await oauthScope(request);
  if (scope instanceof Response) return scope;
  if (scope) {
    const owner = session.binding || bindingFor(state);
    if (!owner ? scope.ctx.instanceRole !== "owner" : !ownerMatches(owner, scope.ctx.userId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  if (session.status === "done" || session.status === "error") {
    // binding carries the principal ctx snapshot — never serialize it to the client.
    const { binding: _binding, ...payload } = session;
    if (provider === "xiaomi-mimo") {
      // Unlike the others this does not auto-exchange server-side, so a
      // finished session must survive until the client POSTs /exchange —
      // that call clears it. A failed one is cleared here instead.
      if (session.status === "error") {
        clearXiaomiMimoSession(state);
        stopXiaomiMimoProxy();
        forgetBinding(state);
      }
      return NextResponse.json(payload);
    }
    if (provider === "trae") clearTraeSession(state);
    else if (provider === "windsurf") clearWindsurfSession(state);
    else if (provider === "zed") clearZedSession(state);
    else if (provider === "xai") clearXaiSession(state);
    else clearCodexSession(state);
    forgetBinding(state);
    return NextResponse.json(payload);
  }
  return NextResponse.json({ status: session.status });
}
