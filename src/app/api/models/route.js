import { NextResponse } from "next/server";
import {
  getDisabledModels,
  getDisabledModelsUnscoped,
  getCustomModels,
  getCustomModelsUnscoped,
  getModelAliases,
  getModelAliasesUnscoped,
  setModelAlias,
  setModelAliasUnscoped,
} from "@/lib/db/index.js";
import { AI_MODELS } from "@/shared/constants/config";
import { getProviderAlias } from "@/shared/constants/providers";
import { workspaceScope } from "@/lib/users/workspaceScope.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

function buildModelsResponse(modelAliases, disabled, customModels) {
  const models = AI_MODELS.filter((m) => {
    const alias = getProviderAlias(m.provider) || m.provider;
    const list = disabled[alias] || disabled[m.provider] || [];
    return !list.includes(m.model);
  }).map((m) => {
    const fullModel = `${m.provider}/${m.model}`;
    const providerAlias = getProviderAlias(m.provider) || m.provider;
    const routedModel = `${providerAlias}/${m.model}`;
    const c = getCapabilitiesForModel(m.provider, m.model);
    return {
      ...m,
      fullModel,
      routedModel,
      alias: modelAliases[fullModel] || m.model,
      caps: {
        vision: c.vision,
        search: c.search,
        reasoning: c.reasoning,
        contextWindow: c.contextWindow,
        maxOutput: c.maxOutput,
      },
    };
  });

  // Custom models ride along; their stored caps override the name heuristic
  const seenFull = new Set(models.map((m) => m.fullModel));
  const customs = (customModels || []).filter((m) => {
    if (!m?.id || (m.kind || m.type || "llm") !== "llm") return false;
    return !seenFull.has(`${m.providerAlias}/${m.id}`);
  });
  for (const m of customs) {
    const fullModel = `${m.providerAlias}/${m.id}`;
    const c = getCapabilitiesForModel(m.providerAlias, m.id);
    models.push({
      provider: m.providerAlias,
      model: m.id,
      name: m.name || m.id,
      fullModel,
      routedModel: fullModel,
      alias: modelAliases[fullModel] || m.id,
      caps: {
        vision: c.vision,
        search: c.search,
        reasoning: c.reasoning,
        contextWindow: c.contextWindow,
        maxOutput: c.maxOutput,
        ...(m.caps || {}),
      },
    });
  }

  return { models };
}

// GET /api/models - Get models with aliases
export async function GET(request) {
  try {
    // YAN-364: switch on → this workspace's aliases/custom/disabled; off → all (today).
    const scope = await workspaceScope(request, "workspace.connections.metadata.read");
    if (scope instanceof Response) return scope;
    const modelAliases = scope
      ? await getModelAliases(scope.ctx, scope.workspaceId)
      : await getModelAliasesUnscoped();
    const disabled = scope
      ? await getDisabledModels(scope.ctx, scope.workspaceId)
      : await getDisabledModelsUnscoped();
    const customModels = scope
      ? await getCustomModels(scope.ctx, scope.workspaceId)
      : await getCustomModelsUnscoped();

    return NextResponse.json(buildModelsResponse(modelAliases, disabled, customModels));
  } catch (error) {
    console.log("Error fetching models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}

// PUT /api/models - Update model alias
export async function PUT(request) {
  try {
    const scope = await workspaceScope(request, "workspace.combos.manage");
    if (scope instanceof Response) return scope;
    const body = await request.json();
    const { model, alias } = body;

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    // Scoped writes reject the reserved `ws:` key namespace (ADR-0001); the key here is `model`.
    if (scope && typeof model === "string" && model.startsWith("ws:")) {
      return NextResponse.json({ error: "Reserved key prefix" }, { status: 400 });
    }

    const modelAliases = scope
      ? await getModelAliases(scope.ctx, scope.workspaceId)
      : await getModelAliasesUnscoped();

    // Check if alias already exists for different model (inside this workspace only)
    const existingModel = Object.entries(modelAliases).find(
      ([key, val]) => val === alias && key !== model,
    );

    if (existingModel) {
      return NextResponse.json({ error: "Alias already in use" }, { status: 400 });
    }

    // Update alias
    if (scope) {
      await setModelAlias(scope.ctx, scope.workspaceId, model, alias);
    } else {
      await setModelAliasUnscoped(model, alias);
    }
    import("@/shared/services/quotaSnapshotPoller")
      .then(({ syncQuotaSnapshotPoller }) => syncQuotaSnapshotPoller())
      .catch((error) => console.warn("[Models] quota poller sync failed:", error?.message));

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}
