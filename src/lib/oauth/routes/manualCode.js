import { NextResponse } from "next/server";
import { exchangeTokens } from "@/lib/oauth/providers";
import {
  stopXaiProxy,
  getXaiSessionStatus,
  clearXaiSession,
  createSessionConnection,
} from "@/lib/oauth/utils/server";
import { bindingFor, forgetBinding, ownerMatches } from "@/lib/oauth/pendingBinding";
import { oauthScope } from "@/lib/oauth/scope";

async function completeXaiManualCode(code, state, session) {
  if (!session) {
    throw new Error("xAI OAuth session not found; restart the login flow and paste the code again");
  }
  if (!code) throw new Error("Missing xAI authorization code");

  try {
    const tokenData = await exchangeTokens(
      "xai",
      code,
      session.redirectUri,
      session.codeVerifier,
      state,
    );
    const connection = await createSessionConnection(session.binding, {
      provider: "xai",
      authType: "oauth",
      ...tokenData,
      expiresAt: tokenData.expiresIn
        ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
        : null,
      testStatus: "active",
    });
    clearXaiSession(state);
    stopXaiProxy();
    return {
      id: connection.id,
      provider: connection.provider,
      email: connection.email,
      displayName: connection.displayName,
    };
  } catch (err) {
    clearXaiSession(state);
    stopXaiProxy();
    throw err;
  }
}

// POST /api/oauth/xai/manual-code - complete the manual-paste fallback for xAI
export default async function manualCode(provider, request, { body }) {
  if (provider !== "xai") {
    return NextResponse.json({ error: "Manual code only supported for xai" }, { status: 400 });
  }
  const { code, state } = body;
  const trimmedState = String(state || "").trim();

  // Manual paste still completes the registered session — only its owner may.
  const scope = await oauthScope(request);
  if (scope instanceof Response) return scope;
  const session = trimmedState ? getXaiSessionStatus(trimmedState) : null;
  const owner = session?.binding || (trimmedState ? bindingFor(trimmedState) : null);
  if (
    scope &&
    (!owner ? scope.ctx.instanceRole !== "owner" : !ownerMatches(owner, scope.ctx.userId))
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const connection = await completeXaiManualCode(String(code || "").trim(), trimmedState, session);
  if (trimmedState) forgetBinding(trimmedState);
  return NextResponse.json({ success: true, connection });
}
