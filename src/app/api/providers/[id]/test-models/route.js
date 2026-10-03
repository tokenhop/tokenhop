import { NextResponse } from "next/server";
import { getProviderConnectionByIdUnscoped } from "@/lib/localDb";
import { getConnection } from "@/lib/db/index.js";
import { loadScoped } from "@/lib/users/workspaceScope.js";
import { getProviderModels, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import {
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
} from "@/shared/constants/providers";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { pingModelByKind } from "@/app/api/models/test/ping";
import { GET as listProviderModels } from "../models/route.js";

/**
 * POST /api/providers/[id]/test-models
 * id = connectionId — used only to resolve provider + model list.
 * Actual requests go through the internal endpoint that matches each model kind.
 */
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const loaded = await loadScoped(
      "workspace.connections.use",
      id,
      getConnection,
      getProviderConnectionByIdUnscoped,
      "Connection not found",
    );
    if (loaded instanceof Response) return loaded;
    const connection = loaded.row;

    const providerId = connection.provider;
    const isCompatible =
      isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);
    const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;

    let models = getProviderModels(alias);

    const baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;

    // Compatible providers: list live models in-process. An HTTP self-fetch of the
    // login-gated /api/providers route carries no dashboard credentials (401).
    if (isCompatible && models.length === 0) {
      try {
        const modelsRes = await listProviderModels(
          new Request(`${baseUrl}/api/providers/${id}/models`),
          { params: Promise.resolve({ id }) },
        );
        if (modelsRes.ok) {
          const data = await modelsRes.json();
          models = (data.models || []).map((m) => ({ id: m.id || m.name, name: m.name || m.id }));
        }
      } catch {
        /* fallback to empty */
      }
    }

    if (models.length === 0) {
      return NextResponse.json(
        { error: "No models configured for this provider" },
        { status: 400 },
      );
    }

    // Warm up with first model to trigger token refresh (if needed) before parallel calls.
    // This prevents race condition where multiple requests concurrently refresh the same token.
    const [first, ...rest] = models;
    const firstKind = first.kind || first.type || "llm";
    const firstResult = await pingModelByKind(`${alias}/${first.id}`, firstKind, baseUrl);
    const results = [{ modelId: first.id, name: first.name || first.id, ...firstResult }];

    if (rest.length > 0) {
      const restResults = await Promise.all(
        rest.map(async (model) => {
          const result = await pingModelByKind(
            `${alias}/${model.id}`,
            model.kind || model.type || "llm",
            baseUrl,
          );
          return { modelId: model.id, name: model.name || model.id, ...result };
        }),
      );
      results.push(...restResults);
    }

    return NextResponse.json({ provider: providerId, connectionId: id, results });
  } catch (error) {
    console.log("Error testing models:", error);
    return NextResponse.json({ error: "Test failed" }, { status: 500 });
  }
}
