import { NextResponse } from "next/server";
import { exchangeTokens } from "@/lib/oauth/providers";
import { readDesktopPassToken } from "open-sse/shared/mimoAccount.js";
import {
  stopXiaomiMimoProxy,
  getXiaomiMimoSessionStatus,
  clearXiaomiMimoSession,
} from "@/lib/oauth/utils/server";
import { forgetBinding } from "@/lib/oauth/pendingBinding";
import { createIn, requireFlowOwner } from "@/lib/oauth/scope";

// POST /api/oauth/[provider]/exchange - Exchange code for tokens and save
export default async function exchange(provider, request, { body }) {
  const { code, redirectUri, codeVerifier, state, meta, systemId } = body;

  // Binding present → caller must be the flow owner; xiaomi-mimo's whole flow
  // is server-side, so it requires a binding (authorize registers one).
  const scope = await requireFlowOwner(request, state, {
    required: provider === "xiaomi-mimo",
  });
  if (scope instanceof Response) return scope;

  // Xiaomi MiMo: no token exchange needed — the callback already decrypted the sk.
  // Just read the session result and create the connection.
  if (provider === "xiaomi-mimo") {
    if (!state) {
      return NextResponse.json({ error: "Missing state" }, { status: 400 });
    }
    const session = getXiaomiMimoSessionStatus(state);
    if (session?.status !== "done" || !session.result) {
      return NextResponse.json(
        {
          error: session?.error || "OAuth session not completed. Please restart the login flow.",
        },
        { status: 400 },
      );
    }
    const { uid, accessToken, baseUrl } = session.result;

    // Desktop-exclusive Preview models authenticate with the account-session
    // passToken, which only lives in MiMo Desktop's cookie store — attach it
    // to the connection so those models work right after OAuth.
    let passToken = null;
    try {
      passToken = await readDesktopPassToken();
    } catch {
      // Desktop not installed / cookie DB locked — preview models stay unavailable.
    }

    try {
      const connection = await createIn(scope, {
        provider: "xiaomi-mimo",
        authType: "oauth",
        accessToken,
        refreshToken: null,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        email: uid ? `${uid}@xiaomi` : null,
        displayName: uid ? `Xiaomi ${uid}` : "Xiaomi MiMo",
        providerSpecificData: {
          uid: uid || null,
          baseUrl: baseUrl || "https://api.xiaomimimo.com/v1",
          authMethod: "oauth",
          mimoPassToken: passToken?.passToken || null,
          mimoUserId: passToken?.userId || null,
          mimoCUserId: passToken?.cUserId || null,
        },
        testStatus: "active",
      });
      clearXiaomiMimoSession(state);
      stopXiaomiMimoProxy();
      forgetBinding(state);
      return NextResponse.json({
        success: true,
        connection: {
          id: connection.id,
          provider: connection.provider,
          email: connection.email,
          displayName: connection.displayName,
        },
      });
    } catch (err) {
      clearXiaomiMimoSession(state);
      stopXiaomiMimoProxy();
      forgetBinding(state);
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  }

  // Trae/Windsurf: code is either a raw callback URL or a pasted token.
  // exchangeTokens() handles both paths; no PKCE, skip codex JWT extraction.
  if (provider === "trae" || provider === "windsurf") {
    const token = typeof code === "string" ? code.trim() : "";
    if (!token) {
      return NextResponse.json({ error: "Missing token or callback URL" }, { status: 400 });
    }
    try {
      const tokenData = await exchangeTokens(provider, token, null, null, state);
      const connection = await createIn(scope, {
        provider,
        authType: provider === "windsurf" ? "api_key" : "oauth",
        ...tokenData,
        expiresAt: tokenData.expiresIn
          ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
          : null,
        testStatus: "active",
      });
      if (state) forgetBinding(state);
      return NextResponse.json({
        success: true,
        connection: {
          id: connection.id,
          provider: connection.provider,
          email: connection.email,
          displayName: connection.displayName,
        },
      });
    } catch (err) {
      if (state) forgetBinding(state);
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  }

  // Detect if "code" is actually a raw JWT access token (starts with eyJ)
  if (code?.startsWith("eyJ") && code.includes(".")) {
    const { extractCodexAccountInfo } = await import("@/lib/oauth/providers");
    const info = extractCodexAccountInfo(code);

    // Also decode JWT directly for ChatGPT website tokens which use
    // top-level account_id/plan_type instead of nested openai auth claims
    let directPayload = {};
    try {
      const b64 = code.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      directPayload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    } catch {}

    const accountId = info.chatgptAccountId || directPayload.account_id;
    const planType = info.chatgptPlanType || directPayload.plan_type;
    const email = info.email || directPayload.email;

    const providerSpecificData = { authMethod: "access_token" };
    if (accountId) providerSpecificData.chatgptAccountId = accountId;
    if (planType) providerSpecificData.chatgptPlanType = planType;

    const connection = await createIn(scope, {
      provider,
      authType: "access_token",
      accessToken: code,
      email: email || null,
      providerSpecificData,
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        displayName: connection.displayName,
      },
    });
  }

  // Cline and ClinePass use authorization_code without PKCE. Kimchi returns a browser token.
  const noPkceExchangeProviders = ["cline", "clinepass", "kimchi"];
  if (!code || !redirectUri || (!codeVerifier && !noPkceExchangeProviders.includes(provider))) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Exchange code for tokens (meta carries provider-specific params, e.g. gitlab clientId/baseUrl).
  // systemId (Zed) is merged into meta so the login attempt's own id is
  // used instead of a freshly prepared one. Ignored by other providers.
  const tokenData = await exchangeTokens(provider, code, redirectUri, codeVerifier, state, {
    ...(meta || {}),
    ...(systemId ? { systemId } : {}),
  });

  // Save to database
  const connection = await createIn(scope, {
    provider,
    authType: "oauth",
    ...tokenData,
    expiresAt: tokenData.expiresIn
      ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
      : null,
    testStatus: "active",
  });
  if (state) forgetBinding(state);

  return NextResponse.json({
    success: true,
    connection: {
      id: connection.id,
      provider: connection.provider,
      email: connection.email,
      displayName: connection.displayName,
    },
  });
}
