import { NextResponse } from "next/server";
import { CursorService } from "@/lib/oauth/services/cursor";
import { createIn, oauthScope } from "@/lib/oauth/scope";

// Cursor session JWTs are ~1 KB; anything this large is not a real token.
const MAX_TOKEN_LENGTH = 16384;

/**
 * POST /api/oauth/cursor/import
 * Import and validate access token from Cursor IDE's local SQLite database
 *
 * Request body:
 * - accessToken: string - Access token from cursorAuth/accessToken
 * - machineId: string - Machine ID from storage.serviceMachineId
 * - refreshToken?: string - Optional refresh token from cursorAuth/refreshToken
 *   (defaults to the access token, which Cursor accepts as a refresh token)
 */
export async function POST(request) {
  try {
    // YAN-366: switch on (2+ users) the connection lands in the caller's
    // workspace (personal default); switch off the legacy unscoped create runs.
    const scope = await oauthScope(request);
    if (scope instanceof Response) return scope;
    const { accessToken, machineId, refreshToken } = await request.json();

    if (!accessToken || typeof accessToken !== "string") {
      return NextResponse.json({ error: "Access token is required" }, { status: 400 });
    }

    if (accessToken.length > MAX_TOKEN_LENGTH) {
      return NextResponse.json({ error: "Access token is too long" }, { status: 400 });
    }

    if (!machineId || typeof machineId !== "string") {
      return NextResponse.json({ error: "Machine ID is required" }, { status: 400 });
    }

    if (refreshToken !== undefined && refreshToken !== null && typeof refreshToken !== "string") {
      return NextResponse.json({ error: "Refresh token must be a string" }, { status: 400 });
    }

    if (typeof refreshToken === "string" && refreshToken.length > MAX_TOKEN_LENGTH) {
      return NextResponse.json({ error: "Refresh token is too long" }, { status: 400 });
    }

    const cursorService = new CursorService();

    // Validate token format (no upstream call)
    const tokenData = await cursorService.validateImportToken(
      accessToken.trim(),
      machineId.trim(),
      refreshToken,
    );

    // Try to extract user info from token
    const userInfo = cursorService.extractUserInfo(tokenData.accessToken);

    // Save to database
    const connection = await createIn(scope, {
      provider: "cursor",
      authType: "oauth",
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresAt: new Date(Date.now() + tokenData.expiresIn * 1000).toISOString(),
      email: userInfo?.email || null,
      providerSpecificData: {
        machineId: tokenData.machineId,
        authMethod: "imported",
        provider: "Imported",
        userId: userInfo?.userId,
      },
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
    console.log("Cursor import token error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * GET /api/oauth/cursor/import
 * Get instructions for importing Cursor token
 */
export async function GET() {
  const cursorService = new CursorService();
  const instructions = cursorService.getTokenStorageInstructions();

  return NextResponse.json({
    provider: "cursor",
    method: "import_token",
    instructions,
    requiredFields: [
      {
        name: "accessToken",
        label: "Access token",
        description: "From cursorAuth/accessToken in state.vscdb",
        type: "textarea",
      },
      {
        name: "machineId",
        label: "Machine ID",
        description: "From storage.serviceMachineId in state.vscdb",
        type: "text",
      },
      {
        name: "refreshToken",
        label: "Refresh token (optional)",
        description:
          "From cursorAuth/refreshToken in state.vscdb. Defaults to the access token when omitted.",
        type: "textarea",
        optional: true,
      },
    ],
  });
}
