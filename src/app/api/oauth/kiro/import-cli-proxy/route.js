import { NextResponse } from "next/server";
import { createIn, oauthScope } from "@/lib/oauth/scope";
import { normalizeKiroExternalIdpAuth } from "@/lib/oauth/kiroExternalIdp.js";

/**
 * POST /api/oauth/kiro/import-cli-proxy
 * Import Kiro CLIProxyAPI auth JSON for Microsoft external_idp accounts.
 */
export async function POST(request) {
  // YAN-366: scoped create (personal default); switch off keeps unscoped.
  const scope = await oauthScope(request);
  if (scope instanceof Response) return scope;

  try {
    const body = await request.json();
    const rawAuth = body?.cliProxyAuth ?? body?.auth ?? body?.json ?? body;
    const tokenData = normalizeKiroExternalIdpAuth(rawAuth);

    const connection = await createIn(scope, {
      provider: "kiro",
      authType: "oauth",
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresAt: tokenData.expiresAt,
      email: tokenData.email || null,
      providerSpecificData: tokenData.providerSpecificData,
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "CLIProxyAPI import failed" },
      { status: 400 },
    );
  }
}
