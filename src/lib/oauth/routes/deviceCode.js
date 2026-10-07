import { NextResponse } from "next/server";
import { getProvider, generateAuthData, requestDeviceCode } from "@/lib/oauth/providers";
import { rememberBinding } from "@/lib/oauth/pendingBinding";
import { oauthScope } from "@/lib/oauth/scope";

// GET /api/oauth/[provider]/device-code - request device code (device_code flow)
export default async function deviceCode(provider, request, { searchParams }) {
  const scope = await oauthScope(request);
  if (scope instanceof Response) return scope;

  const providerData = getProvider(provider);
  if (providerData.flowType !== "device_code") {
    return NextResponse.json(
      { error: "Provider does not support device code flow" },
      { status: 400 },
    );
  }

  const authData = await generateAuthData(provider, null);
  const startUrl = searchParams.get("start_url");
  const region = searchParams.get("region");
  const authMethod = searchParams.get("auth_method");
  const deviceOptions =
    provider === "kiro"
      ? {
          ...(startUrl ? { startUrl } : {}),
          ...(region ? { region } : {}),
          ...(authMethod ? { authMethod } : {}),
        }
      : undefined;

  // Providers that don't use PKCE for device code (Grok CLI HAR: plain device_code, no challenge)
  const noPkceDeviceProviders = [
    "github",
    "kiro",
    "kimi",
    "kimi-coding",
    "kilocode",
    "codebuddy-cn",
    "codebuddy-intl",
    "qoder",
    "grok-cli",
    "meta-code",
  ];
  let deviceData;
  if (noPkceDeviceProviders.includes(provider)) {
    deviceData = await requestDeviceCode(provider, undefined, deviceOptions);
  } else {
    // Qwen and other PKCE providers
    deviceData = await requestDeviceCode(provider, authData.codeChallenge, deviceOptions);
  }

  const payload = {
    ...deviceData,
    // Prefer the verifier the provider's requestDeviceCode generated for
    // itself (qoder rolls its own PKCE pair); fall back to the generic one.
    codeVerifier: deviceData.codeVerifier || authData.codeVerifier,
  };

  // Bind the device code to the starting principal — the client echoes this
  // exact value back as body.deviceCode on /poll, which enforces ownership.
  if (scope && payload.device_code) {
    rememberBinding(payload.device_code, {
      provider,
      userId: scope.ctx.userId,
      workspaceId: scope.workspaceId,
      ctx: scope.ctx,
    });
  }
  return NextResponse.json(payload);
}
