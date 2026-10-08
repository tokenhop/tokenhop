import { NextResponse } from "next/server";
import {
  createProviderConnectionUnscoped,
  getProviderNodeByIdUnscoped,
  getProxyPoolById,
} from "@/models";
import { createConnection, getNode } from "@/lib/db/index.js";
import {
  getProviderConnectionsMetadataUnscoped,
  listConnectionsMetadata,
} from "@/lib/db/repos/connectionsRepo.js";
import { getProviderNodesMetadataUnscoped, listNodesMetadata } from "@/lib/db/repos/nodesRepo.js";
import { redactConnection, workspaceScope } from "@/lib/users/workspaceScope.js";
import { APIKEY_PROVIDERS } from "@/shared/constants/config";
import {
  AI_PROVIDERS,
  FREE_TIER_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
  isCustomEmbeddingProvider,
} from "@/shared/constants/providers";
import { normalizeProviderId, normalizeProviderSpecificData } from "@/lib/providerNormalization";
import { getSnapshot } from "open-sse/services/quotaSnapshot.js";
import { effectiveWeightFor } from "@/sse/services/accountSelection";
import { remainingFromWindows } from "@/lib/home/quota.js";

/** Quota left (0-100) from the in-memory snapshot, null when none or on failure. */
function quotaRemainingFor(snapshot) {
  try {
    return remainingFromWindows(snapshot?.windows);
  } catch {
    return null;
  }
}

export const dynamic = "force-dynamic";

function normalizeProxyConfig(body = {}) {
  const enabled = body?.connectionProxyEnabled === true;
  const url = typeof body?.connectionProxyUrl === "string" ? body.connectionProxyUrl.trim() : "";
  const noProxy = typeof body?.connectionNoProxy === "string" ? body.connectionNoProxy.trim() : "";

  if (enabled && !url) {
    return { error: "Connection proxy URL is required when connection proxy is enabled" };
  }

  return {
    connectionProxyEnabled: enabled,
    connectionProxyUrl: url,
    connectionNoProxy: noProxy,
  };
}

async function normalizeProxyPoolId(proxyPoolId) {
  if (
    proxyPoolId === undefined ||
    proxyPoolId === null ||
    proxyPoolId === "" ||
    proxyPoolId === "__none__"
  ) {
    return { proxyPoolId: null };
  }

  const normalizedId = String(proxyPoolId).trim();
  if (!normalizedId) {
    return { proxyPoolId: null };
  }

  const proxyPool = await getProxyPoolById(normalizedId);
  if (!proxyPool) {
    return { error: "Proxy pool not found" };
  }

  return { proxyPoolId: normalizedId };
}

// GET /api/providers - List all connections
export async function GET(request) {
  try {
    // YAN-361: switch on → one workspace's connections; off → all (today).
    const scope = await workspaceScope(request, "workspace.connections.metadata.read");
    if (scope instanceof Response) return scope;
    // YAN-365: metadata list — covered secrets are never decrypted; each row
    // reports its `configured` dotted paths and one corrupt envelope cannot
    // break the response.
    const connections = scope
      ? await listConnectionsMetadata(scope.ctx, scope.workspaceId)
      : await getProviderConnectionsMetadataUnscoped();

    // Build nodeNameMap for compatible providers (id → name)
    const nodeNameMap = {};
    try {
      const nodes = scope
        ? await listNodesMetadata(scope.ctx, scope.workspaceId)
        : await getProviderNodesMetadataUnscoped();
      for (const node of nodes) {
        if (node.id && node.name) nodeNameMap[node.id] = node.name;
      }
    } catch {}

    // Hide sensitive fields, enrich name for compatible providers
    const safeConnections = connections.map((c) => {
      const isCompatible =
        isOpenAICompatibleProvider(c.provider) || isAnthropicCompatibleProvider(c.provider);
      const name = isCompatible
        ? c.name || nodeNameMap[c.provider] || c.providerSpecificData?.nodeName || c.provider
        : c.name;
      const snapshot = getSnapshot(c.id);
      return {
        ...redactConnection(scope, c),
        name,
        effectiveWeight: effectiveWeightFor(c, { snapshot }),
        quotaRemaining: quotaRemainingFor(snapshot),
        apiKey: undefined,
        accessToken: undefined,
        refreshToken: undefined,
        idToken: undefined,
      };
    });

    return NextResponse.json({ connections: safeConnections });
  } catch (error) {
    console.log("Error fetching providers:", error);
    return NextResponse.json({ error: "Failed to fetch providers" }, { status: 500 });
  }
}

// POST /api/providers - Create new connection (API key only, OAuth via separate flow)
export async function POST(request) {
  try {
    const scope = await workspaceScope(request, "workspace.connections.manage");
    if (scope instanceof Response) return scope;
    // A node outside the target workspace reads as not found.
    const nodeById = async (id) => {
      if (!scope) return getProviderNodeByIdUnscoped(id);
      const node = await getNode(scope.ctx, id);
      return node?.workspaceId === scope.workspaceId ? node : null;
    };
    const body = await request.json();
    const provider = normalizeProviderId(body.provider);
    const { apiKey, name, displayName, priority, globalPriority, defaultModel, testStatus } = body;
    const proxyConfig = normalizeProxyConfig(body);
    if (proxyConfig.error) {
      return NextResponse.json({ error: proxyConfig.error }, { status: 400 });
    }

    const proxyPoolResult = await normalizeProxyPoolId(body.proxyPoolId);
    if (proxyPoolResult.error) {
      return NextResponse.json({ error: proxyPoolResult.error }, { status: 400 });
    }
    const proxyPoolId = proxyPoolResult.proxyPoolId;

    // Validation
    const isWebCookieProvider = !!WEB_COOKIE_PROVIDERS[provider];
    // Dual-auth providers (e.g. codebuddy-cn, xai) live under category "oauth" but also
    // accept an API key via authModes — they aren't in APIKEY_PROVIDERS, so allow them here.
    const supportsApiKeyMode = !!AI_PROVIDERS[provider]?.authModes?.includes("apikey");
    const isValidProvider =
      APIKEY_PROVIDERS[provider] ||
      FREE_TIER_PROVIDERS[provider] ||
      supportsApiKeyMode ||
      isWebCookieProvider ||
      isOpenAICompatibleProvider(provider) ||
      isAnthropicCompatibleProvider(provider) ||
      isCustomEmbeddingProvider(provider);

    if (!provider || !isValidProvider) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
    }
    if (!apiKey && provider !== "ollama-local") {
      return NextResponse.json(
        { error: `${isWebCookieProvider ? "Cookie value" : "API key"} is required` },
        { status: 400 },
      );
    }
    const connectionName = name || displayName || AI_PROVIDERS[provider]?.name;
    if (!connectionName) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    let providerSpecificData = normalizeProviderSpecificData(
      provider,
      body,
      body.providerSpecificData,
    );

    // Compatible LLM nodes support multiple API-key connections (key pool); runtime
    // rotates/fails over via getProviderCredentials. Embedding nodes stay single-connection.
    if (isOpenAICompatibleProvider(provider)) {
      const node = await nodeById(provider);
      if (!node) {
        return NextResponse.json({ error: "OpenAI Compatible node not found" }, { status: 404 });
      }
      providerSpecificData = {
        prefix: node.prefix,
        apiType: node.apiType,
        ...(node.apiType === "completions" && node.fimTemplate
          ? { fimTemplate: node.fimTemplate }
          : {}),
        baseUrl: node.baseUrl,
        nodeName: node.name,
      };
    } else if (isAnthropicCompatibleProvider(provider)) {
      const node = await nodeById(provider);
      if (!node) {
        return NextResponse.json({ error: "Anthropic Compatible node not found" }, { status: 404 });
      }
      providerSpecificData = {
        prefix: node.prefix,
        baseUrl: node.baseUrl,
        nodeName: node.name,
      };
    } else if (isCustomEmbeddingProvider(provider)) {
      const node = await nodeById(provider);
      if (!node) {
        return NextResponse.json({ error: "Custom Embedding node not found" }, { status: 404 });
      }
      providerSpecificData = {
        prefix: node.prefix,
        baseUrl: node.baseUrl,
        nodeName: node.name,
      };
    }

    const mergedProviderSpecificData = {
      ...(providerSpecificData || {}),
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled,
      connectionProxyUrl: proxyConfig.connectionProxyUrl,
      connectionNoProxy: proxyConfig.connectionNoProxy,
    };

    if (proxyPoolId !== null) {
      mergedProviderSpecificData.proxyPoolId = proxyPoolId;
    }

    const authType = isWebCookieProvider ? "cookie" : "apikey";
    // createProviderConnectionUnscoped upserts apikey rows by name; reject inside its
    // transaction so a reused name never silently replaces another connection's key.
    const create = scope
      ? (data, opts) => createConnection(scope.ctx, scope.workspaceId, data, opts)
      : createProviderConnectionUnscoped;
    const newConnection = await create(
      {
        provider,
        authType,
        name: connectionName,
        apiKey: apiKey || "",
        priority: priority || 1,
        globalPriority: globalPriority || null,
        defaultModel: defaultModel || null,
        providerSpecificData: mergedProviderSpecificData,
        isActive: true,
        testStatus: testStatus || "unknown",
      },
      { rejectDuplicateName: true },
    );

    // Hide sensitive fields
    const result = { ...redactConnection(scope, newConnection) };
    delete result.apiKey;

    return NextResponse.json({ connection: result }, { status: 201 });
  } catch (error) {
    if (error?.code === "DUPLICATE_CONNECTION_NAME") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.log("Error creating provider:", error);
    return NextResponse.json({ error: "Failed to create provider" }, { status: 500 });
  }
}
