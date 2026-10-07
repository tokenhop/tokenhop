import { NextResponse } from "next/server";
import { generatePKCE } from "@/lib/oauth/utils/pkce";
import { KiroService } from "@/lib/oauth/services/kiro";
import { rememberBinding } from "@/lib/oauth/pendingBinding";
import { oauthScope } from "@/lib/oauth/scope";

/**
 * GET /api/oauth/kiro/social-authorize
 * Generate Google/GitHub social login URL for manual callback flow
 * Uses kiro:// custom protocol as required by AWS Cognito
 */
export async function GET(request) {
  try {
    // YAN-366: scoped flows bind the pending state to the initiating
    // principal, so the exchange step can verify the owner; switch off
    // (or ≤1 active user) keeps the stateless flow unchanged.
    const scope = await oauthScope(request);
    if (scope instanceof Response) return scope;

    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider"); // "google" or "github"

    if (!provider || !["google", "github"].includes(provider)) {
      return NextResponse.json(
        { error: "Invalid provider. Use 'google' or 'github'" },
        { status: 400 },
      );
    }

    // Generate PKCE for social auth
    const { codeVerifier, codeChallenge, state } = generatePKCE();

    if (scope) {
      rememberBinding(state, {
        provider: "kiro",
        userId: scope.ctx.userId,
        workspaceId: scope.workspaceId,
        ctx: scope.ctx,
      });
    }

    const kiroService = new KiroService();
    const authUrl = kiroService.buildSocialLoginUrl(provider, codeChallenge, state);

    return NextResponse.json({
      authUrl,
      state,
      codeVerifier,
      codeChallenge,
      provider,
    });
  } catch (error) {
    console.log("Kiro social authorize error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
