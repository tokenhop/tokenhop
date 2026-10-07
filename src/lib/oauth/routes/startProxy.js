import { NextResponse } from "next/server";
import {
  startCodexProxy,
  registerCodexSession,
  startXaiProxy,
  registerXaiSession,
  startTraeProxy,
  startWindsurfProxy,
  startZedProxy,
  startXiaomiMimoProxy,
} from "@/lib/oauth/utils/server";
import { ZED_HOSTED_CONFIG } from "@/lib/oauth/constants/oauth";
import { hostOnlyRefusal, oauthScope } from "@/lib/oauth/scope";

// GET /api/oauth/[provider]/start-proxy - loopback callback server (host only)
export default async function startProxy(provider, request, { searchParams }) {
  const refused = await hostOnlyRefusal(request);
  if (refused) return refused;
  const scope = await oauthScope(request);
  if (scope instanceof Response) return scope;
  const binding = scope
    ? { userId: scope.ctx.userId, workspaceId: scope.workspaceId, ctx: scope.ctx }
    : undefined;

  // Trae/Windsurf/Zed use a dynamic-port local callback server (singleton session,
  // state is registered separately via /register-session after /authorize).
  if (provider === "trae") {
    const result = await startTraeProxy();
    return NextResponse.json(result);
  }
  if (provider === "windsurf") {
    const result = await startWindsurfProxy();
    return NextResponse.json(result);
  }
  if (provider === "zed") {
    // Prefer ZED_HOSTED_CONFIG.defaultNativeAppPort (58443) so the browser redirect
    // matches what Zed expects; falls back to a random port if it's busy.
    const result = await startZedProxy(
      searchParams.get("native_app_port") || ZED_HOSTED_CONFIG.defaultNativeAppPort,
    );
    return NextResponse.json(result);
  }
  if (provider === "xiaomi-mimo") {
    const result = await startXiaomiMimoProxy();
    return NextResponse.json(result);
  }
  if (!["codex", "xai"].includes(provider)) {
    return NextResponse.json(
      { error: "Proxy only supported for codex/xai/trae/windsurf/zed" },
      { status: 400 },
    );
  }
  const appPort = searchParams.get("app_port");
  if (!appPort) {
    return NextResponse.json({ error: "Missing app_port" }, { status: 400 });
  }
  const state = searchParams.get("state");
  const codeVerifier = searchParams.get("code_verifier");
  const redirectUri = searchParams.get("redirect_uri");
  const result =
    provider === "xai"
      ? await startXaiProxy(Number(appPort))
      : await startCodexProxy(Number(appPort));
  let serverSide = false;
  if (result.success && state && codeVerifier && redirectUri) {
    const session = { state, codeVerifier, redirectUri, binding };
    serverSide = provider === "xai" ? registerXaiSession(session) : registerCodexSession(session);
  }
  return NextResponse.json({ ...result, serverSide });
}
