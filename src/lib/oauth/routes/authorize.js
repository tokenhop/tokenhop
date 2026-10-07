import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { generateAuthData } from "@/lib/oauth/providers";
import { startXiaomiMimoProxy, registerXiaomiMimoSession } from "@/lib/oauth/utils/server";
import { bindingFor, ownerMatches, rememberBinding } from "@/lib/oauth/pendingBinding";
import { hostOnlyRefusal, oauthScope } from "@/lib/oauth/scope";

// GET /api/oauth/[provider]/authorize - Generate auth URL
export default async function authorize(provider, request, { searchParams }) {
  // Xiaomi Desktop: custom ECDH flow — generate keypair, start proxy, return authorize URL
  if (provider === "xiaomi-mimo") {
    // Loopback proxy + host-bound flow: remote members can't use it.
    const refused = await hostOnlyRefusal(request);
    if (refused) return refused;
    const scope = await oauthScope(request);
    if (scope instanceof Response) return scope;

    const { generateKeyPair, buildAuthorizeUrl, getKeyName } = await import(
      "@/lib/oauth/providers/xiaomi-mimo"
    );
    const { publicKey, privateKeyDer } = generateKeyPair();
    const state = searchParams.get("state") || crypto.randomUUID();
    const existing = scope ? bindingFor(state) : null;
    if (existing && !ownerMatches(existing, scope.ctx.userId)) {
      return NextResponse.json({ error: "state already in use" }, { status: 400 });
    }

    // Start the callback proxy (or reuse if already running)
    const proxyResult = await startXiaomiMimoProxy();
    if (!proxyResult.success) {
      return NextResponse.json(
        { error: `Failed to start callback server: ${proxyResult.reason}` },
        { status: 500 },
      );
    }

    // Register the session with the private key for decryption
    const binding = scope
      ? { userId: scope.ctx.userId, workspaceId: scope.workspaceId, ctx: scope.ctx }
      : undefined;
    registerXiaomiMimoSession({ state, privateKeyDer, binding });
    if (binding) rememberBinding(state, { provider, ...binding });

    const redirectUri = proxyResult.callbackUrl;
    const authorizeUrl = buildAuthorizeUrl(publicKey, redirectUri, getKeyName());

    return NextResponse.json({
      state,
      authorizeUrl,
      redirectUri,
      port: proxyResult.port,
    });
  }

  const scope = await oauthScope(request);
  if (scope instanceof Response) return scope;

  const redirectUri = searchParams.get("redirect_uri") || "http://localhost:8080/callback";
  // Collect provider-specific meta params (e.g. gitlab passes baseUrl, clientId, clientSecret).
  // workspaceId is the scope selector, not provider meta.
  const reservedParams = new Set(["redirect_uri", ...(scope ? ["workspaceId"] : [])]);
  const meta = {};
  searchParams.forEach((value, key) => {
    if (!reservedParams.has(key)) meta[key] = value;
  });
  // Zed: derive native_app_port from the local callback URL so the RSA keypair
  // is bound to the port the proxy is actually listening on.
  if (provider === "zed") {
    try {
      const p = new URL(redirectUri).port;
      if (p) meta.nativeAppPort = p;
    } catch {
      /* ignore */
    }
  }
  const authData = await generateAuthData(
    provider,
    redirectUri,
    Object.keys(meta).length ? meta : undefined,
  );
  if (scope && authData?.state) {
    rememberBinding(authData.state, {
      provider,
      userId: scope.ctx.userId,
      workspaceId: scope.workspaceId,
      ctx: scope.ctx,
    });
  }
  return NextResponse.json(authData);
}
