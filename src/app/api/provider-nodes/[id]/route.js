import { NextResponse } from "next/server";
import {
  deleteProviderConnectionsByProviderUnscoped,
  deleteProviderNodeUnscoped,
  getProviderConnectionsUnscoped,
  getProviderNodeByIdUnscoped,
  updateProviderConnectionUnscoped,
  updateProviderNodeUnscoped,
} from "@/models";
import {
  deleteNode,
  getNode,
  listConnections,
  updateConnection,
  updateNode,
} from "@/lib/db/index.js";
import { loadScoped } from "@/lib/users/workspaceScope.js";
import { FIM_DEFAULT_TEMPLATE, FIM_TEMPLATE_NAMES } from "open-sse/translator/concerns/fim.js";

// YAN-361: switch on, the node must be in one of the principal's workspaces.
const load = (id) =>
  loadScoped(
    "workspace.connections.manage",
    id,
    getNode,
    getProviderNodeByIdUnscoped,
    "Provider node not found",
  );

// PUT /api/provider-nodes/[id] - Update provider node
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, prefix, apiType, fimTemplate, baseUrl } = body;
    const loaded = await load(id);
    if (loaded instanceof Response) return loaded;
    const { scope, row: node } = loaded;

    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (!prefix?.trim()) {
      return NextResponse.json({ error: "Prefix is required" }, { status: 400 });
    }

    // Only validate apiType for OpenAI Compatible nodes
    if (
      node.type === "openai-compatible" &&
      (!apiType || !["chat", "responses", "completions"].includes(apiType))
    ) {
      return NextResponse.json({ error: "Invalid OpenAI compatible API type" }, { status: 400 });
    }

    // fimTemplate only applies to completions nodes; ignored otherwise.
    if (
      node.type === "openai-compatible" &&
      apiType === "completions" &&
      fimTemplate !== undefined &&
      fimTemplate !== null &&
      fimTemplate !== "" &&
      !FIM_TEMPLATE_NAMES.includes(fimTemplate)
    ) {
      return NextResponse.json({ error: "Invalid FIM template" }, { status: 400 });
    }

    if (!baseUrl?.trim()) {
      return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
    }

    let sanitizedBaseUrl = baseUrl.trim();

    // Sanitize Base URL for Anthropic Compatible
    if (node.type === "anthropic-compatible") {
      sanitizedBaseUrl = sanitizedBaseUrl.replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/messages")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -9); // remove /messages
      }
    }

    // Sanitize Base URL for Custom Embedding (strip trailing slash and /embeddings)
    if (node.type === "custom-embedding") {
      sanitizedBaseUrl = sanitizedBaseUrl.replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/embeddings")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -"/embeddings".length);
      }
    }

    const updates = {
      name: name.trim(),
      prefix: prefix.trim(),
      baseUrl: sanitizedBaseUrl,
    };

    if (node.type === "openai-compatible") {
      updates.apiType = apiType;
      // Only meaningful when apiType=completions, otherwise ignore/omit.
      if (apiType === "completions") {
        updates.fimTemplate = fimTemplate || node.fimTemplate || FIM_DEFAULT_TEMPLATE;
      } else {
        // undefined overrides the merged key and is dropped on JSON encode.
        updates.fimTemplate = undefined;
      }
    }

    const updated = scope
      ? await updateNode(scope.ctx, id, updates)
      : await updateProviderNodeUnscoped(id, updates);

    const connections = scope
      ? await listConnections(scope.ctx, node.workspaceId, { provider: id })
      : await getProviderConnectionsUnscoped({ provider: id });
    const update = scope
      ? (cid, data) => updateConnection(scope.ctx, cid, data)
      : updateProviderConnectionUnscoped;
    await Promise.all(
      connections.map((connection) =>
        update(connection.id, {
          // YAN-365: delta write — the repo merges onto the live stored PSD
          // siblings, so a refresh landing between the list and these writes
          // survives. apiType: undefined drops the key (today's shape).
          providerSpecificData: {
            prefix: prefix.trim(),
            apiType: node.type === "openai-compatible" ? apiType : undefined,
            // A null leaf in the PSD delta clears the stored key.
            ...(node.type === "openai-compatible"
              ? {
                  fimTemplate:
                    apiType === "completions"
                      ? fimTemplate || node.fimTemplate || FIM_DEFAULT_TEMPLATE
                      : null,
                }
              : {}),
            baseUrl: sanitizedBaseUrl,
            nodeName: updated.name,
          },
        }),
      ),
    );

    return NextResponse.json({ node: updated });
  } catch (error) {
    if (error?.code === "PREFIX_TAKEN") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.log("Error updating provider node:", error);
    return NextResponse.json({ error: "Failed to update provider node" }, { status: 500 });
  }
}

// DELETE /api/provider-nodes/[id] - Delete provider node and its connections
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const loaded = await load(id);
    if (loaded instanceof Response) return loaded;
    const { scope, row: node } = loaded;

    if (scope) {
      await deleteNode(scope.ctx, id); // node + its connections, one transaction
    } else {
      await deleteProviderConnectionsByProviderUnscoped(id);
      await deleteProviderNodeUnscoped(id);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting provider node:", error);
    return NextResponse.json({ error: "Failed to delete provider node" }, { status: 500 });
  }
}
