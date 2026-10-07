import { NextResponse } from "next/server";
import { pollForToken } from "@/lib/oauth/providers";
import { forgetBinding } from "@/lib/oauth/pendingBinding";
import { createIn, requireFlowOwner } from "@/lib/oauth/scope";

// POST /api/oauth/[provider]/poll - Poll for token (device_code flow)
export default async function poll(provider, request, { body }) {
  const { deviceCode, codeVerifier, extraData } = body;

  if (!deviceCode) {
    return NextResponse.json({ error: "Missing device code" }, { status: 400 });
  }

  // The device code was bound to its starting principal at /device-code;
  // when scoped it is required and only its owner may complete the flow.
  const scope = await requireFlowOwner(request, deviceCode, { required: true });
  if (scope instanceof Response) return scope;

  // Providers that don't use PKCE for device code
  const noPkceProviders = [
    "github",
    "grok-cli",
    "meta-code",
    "kimi",
    "kimi-coding",
    "kilocode",
    "codebuddy-cn",
    "codebuddy-intl",
  ];
  let result;
  if (noPkceProviders.includes(provider)) {
    // kimi needs extraData._kimiDeviceId for stable X-Msh-Device-Id (CLIProxyAPI parity)
    result = await pollForToken(provider, deviceCode, null, extraData);
  } else if (provider === "kiro") {
    // Kiro needs extraData (clientId, clientSecret) from device code response
    result = await pollForToken(provider, deviceCode, null, extraData);
  } else if (provider === "qoder") {
    // Qoder needs both the PKCE verifier (codeVerifier) and the machineId
    // captured at device-code time (extraData._qoderMachineId) so
    // mapTokens can persist it for COSY signing.
    if (!codeVerifier) {
      return NextResponse.json({ error: "Missing code verifier" }, { status: 400 });
    }
    result = await pollForToken(provider, deviceCode, codeVerifier, extraData);
  } else {
    // Qwen and other PKCE providers
    if (!codeVerifier) {
      return NextResponse.json({ error: "Missing code verifier" }, { status: 400 });
    }
    result = await pollForToken(provider, deviceCode, codeVerifier);
  }

  if (result.success) {
    forgetBinding(deviceCode);
    // Save to database (legacy kimi-coding OAuth → dual-auth kimi)
    const providerId = provider === "kimi-coding" ? "kimi" : provider;
    const connection = await createIn(scope, {
      provider: providerId,
      authType: "oauth",
      ...result.tokens,
      expiresAt: result.tokens.expiresIn
        ? new Date(Date.now() + result.tokens.expiresIn * 1000).toISOString()
        : null,
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
      },
    });
  }

  // Still pending or error - don't create connection for pending states
  const isPending =
    result.pending || result.error === "authorization_pending" || result.error === "slow_down";

  return NextResponse.json({
    success: false,
    error: result.error,
    errorDescription: result.errorDescription,
    pending: isPending,
  });
}
