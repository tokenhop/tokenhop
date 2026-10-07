import { NextResponse } from "next/server";
import { createIn, oauthScope } from "@/lib/oauth/scope";
import { listConnections, updateConnection } from "@/lib/db/index.js";

/**
 * POST /api/oauth/xiaomi-mimo/api-key
 * Import a Xiaomi MiMo API key manually (or from auto-import).
 * The key is validated against the models endpoint, then stored.
 *
 * Body: { apiKey, uid?, baseUrl? }
 */
export async function POST(request) {
  try {
    // YAN-366: switch on (2+ users) dedup/create stay inside the target
    // workspace; switch off keeps today's unscoped path byte-identically.
    const scope = await oauthScope(request);
    if (scope instanceof Response) return scope;

    const { apiKey, uid, baseUrl, mimoPassToken, mimoUserId, mimoCUserId } = await request.json();

    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return NextResponse.json({ error: "API key is required" }, { status: 400 });
    }

    const key = apiKey.trim();
    if (!key.startsWith("sk-")) {
      return NextResponse.json(
        { error: "Invalid key format — expected sk- prefix" },
        { status: 400 },
      );
    }

    const effectiveBaseUrl = (baseUrl || "https://api.xiaomimimo.com/v1").replace(/\/+$/, "");

    // Validate the key against the models endpoint
    let validated = false;
    let modelCount = 0;
    try {
      const resp = await fetch(`${effectiveBaseUrl}/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          "X-Mimo-Source": "mimocode-cli",
        },
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const data = await resp.json();
        modelCount = Array.isArray(data?.data) ? data.data.length : 0;
        validated = true;
      }
    } catch {
      // Network error — still allow import (key may be valid but network blocked)
    }

    if (!validated) {
      // Soft-fail: store the key but mark as untested
      console.log("[xiaomi-mimo] key validation failed, storing as untested");
    }

    // Dedup stays inside the target workspace when scoped.
    const { getProviderConnectionsUnscoped, updateProviderConnectionUnscoped } = await import(
      "@/models"
    );
    const candidates = scope
      ? await listConnections(scope.ctx, scope.workspaceId, { provider: "xiaomi-mimo" })
      : await getProviderConnectionsUnscoped();
    const existing = candidates.find(
      (c) =>
        c.provider === "xiaomi-mimo" &&
        ((uid && c.email === `${uid}@xiaomi`) || c.accessToken === key),
    );
    if (existing) {
      const update = scope
        ? (id, data) => updateConnection(scope.ctx, id, data)
        : updateProviderConnectionUnscoped;
      await update(existing.id, {
        accessToken: key,
        providerSpecificData: {
          ...existing.providerSpecificData,
          uid: uid || existing.providerSpecificData?.uid || null,
          baseUrl: effectiveBaseUrl,
          // Per-account session credential — enables multi-account rotation.
          mimoPassToken: mimoPassToken || existing.providerSpecificData?.mimoPassToken || null,
          mimoUserId: mimoUserId || existing.providerSpecificData?.mimoUserId || null,
          mimoCUserId: mimoCUserId || existing.providerSpecificData?.mimoCUserId || null,
          modelCount,
        },
        testStatus: validated ? "active" : existing.testStatus,
      });
      return NextResponse.json({
        success: true,
        validated,
        modelCount,
        updated: true,
        connection: {
          id: existing.id,
          provider: existing.provider,
          email: existing.email,
          displayName: existing.displayName,
        },
      });
    }

    const connection = await createIn(scope, {
      provider: "xiaomi-mimo",
      authType: "api_key",
      accessToken: key,
      refreshToken: null,
      // API keys don't expire on a fixed schedule; use a long horizon
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      email: uid ? `${uid}@xiaomi` : null,
      displayName: uid ? `Xiaomi ${uid}` : "Xiaomi MiMo",
      providerSpecificData: {
        uid: uid || null,
        baseUrl: effectiveBaseUrl,
        authMethod: "api_key",
        provider: "API key",
        modelCount,
        // Per-account session credential — enables multi-account rotation.
        mimoPassToken: mimoPassToken || null,
        mimoUserId: mimoUserId || null,
        mimoCUserId: mimoCUserId || null,
      },
      testStatus: validated ? "active" : "untested",
    });

    return NextResponse.json({
      success: true,
      validated,
      modelCount,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        displayName: connection.displayName,
      },
    });
  } catch (error) {
    console.log("Xiaomi MiMo API key import error:", error);
    return NextResponse.json({ error: "API key import failed" }, { status: 500 });
  }
}
