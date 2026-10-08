import { NextResponse } from "next/server";
import { createProviderNodeUnscoped } from "@/models";
import { createNode } from "@/lib/db/index.js";
import { getProviderNodesMetadataUnscoped, listNodesMetadata } from "@/lib/db/repos/nodesRepo.js";
import { workspaceScope } from "@/lib/users/workspaceScope.js";
import {
  OPENAI_COMPATIBLE_PREFIX,
  ANTHROPIC_COMPATIBLE_PREFIX,
  CUSTOM_EMBEDDING_PREFIX,
} from "@/shared/constants/providers";
import { generateId } from "@/shared/utils";
import { FIM_DEFAULT_TEMPLATE, FIM_TEMPLATE_NAMES } from "open-sse/translator/concerns/fim.js";

export const dynamic = "force-dynamic";

const OPENAI_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

const ANTHROPIC_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.anthropic.com/v1",
};

const CUSTOM_EMBEDDING_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

// GET /api/provider-nodes - List all provider nodes
export async function GET(request) {
  try {
    // YAN-361: switch on, one workspace's nodes.
    const scope = await workspaceScope(request, "workspace.connections.metadata.read");
    if (scope instanceof Response) return scope;
    // YAN-365: metadata list — secrets are never decrypted for responses.
    const nodes = scope
      ? await listNodesMetadata(scope.ctx, scope.workspaceId)
      : await getProviderNodesMetadataUnscoped();
    return NextResponse.json({ nodes });
  } catch (error) {
    console.log("Error fetching provider nodes:", error);
    return NextResponse.json({ error: "Failed to fetch provider nodes" }, { status: 500 });
  }
}

// POST /api/provider-nodes - Create provider node
export async function POST(request) {
  try {
    const scope = await workspaceScope(request, "workspace.connections.manage");
    if (scope instanceof Response) return scope;
    // Switch on: owned by the workspace, prefix unique inside it.
    const createProviderNode = scope
      ? (data) => createNode(scope.ctx, scope.workspaceId, data)
      : createProviderNodeUnscoped;
    const body = await request.json();
    const { name, prefix, apiType, fimTemplate, baseUrl, type } = body;

    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (!prefix?.trim()) {
      return NextResponse.json({ error: "Prefix is required" }, { status: 400 });
    }

    // Determine type
    const nodeType = type || "openai-compatible";

    if (nodeType === "openai-compatible") {
      if (!apiType || !["chat", "responses", "completions"].includes(apiType)) {
        return NextResponse.json({ error: "Invalid OpenAI compatible API type" }, { status: 400 });
      }
      // fimTemplate only applies to completions nodes; ignored otherwise.
      if (
        apiType === "completions" &&
        fimTemplate !== undefined &&
        fimTemplate !== null &&
        fimTemplate !== "" &&
        !FIM_TEMPLATE_NAMES.includes(fimTemplate)
      ) {
        return NextResponse.json({ error: "Invalid FIM template" }, { status: 400 });
      }

      const node = await createProviderNode({
        id: `${OPENAI_COMPATIBLE_PREFIX}${apiType}-${generateId()}`,
        type: "openai-compatible",
        prefix: prefix.trim(),
        apiType,
        ...(apiType === "completions" ? { fimTemplate: fimTemplate || FIM_DEFAULT_TEMPLATE } : {}),
        baseUrl: (baseUrl || OPENAI_COMPATIBLE_DEFAULTS.baseUrl).trim(),
        name: name.trim(),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "custom-embedding") {
      // Strip trailing slash and /embeddings if user pasted full endpoint
      let sanitizedBaseUrl = (baseUrl || CUSTOM_EMBEDDING_DEFAULTS.baseUrl)
        .trim()
        .replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/embeddings")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -"/embeddings".length);
      }

      const node = await createProviderNode({
        id: `${CUSTOM_EMBEDDING_PREFIX}${generateId()}`,
        type: "custom-embedding",
        prefix: prefix.trim(),
        baseUrl: sanitizedBaseUrl,
        name: name.trim(),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "anthropic-compatible") {
      // Sanitize Base URL: remove trailing slash, and remove trailing /messages if user added it
      // This prevents double-appending /messages at runtime
      let sanitizedBaseUrl = (baseUrl || ANTHROPIC_COMPATIBLE_DEFAULTS.baseUrl)
        .trim()
        .replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/messages")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -9); // remove /messages
      }

      const node = await createProviderNode({
        id: `${ANTHROPIC_COMPATIBLE_PREFIX}${generateId()}`,
        type: "anthropic-compatible",
        prefix: prefix.trim(),
        baseUrl: sanitizedBaseUrl,
        name: name.trim(),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    return NextResponse.json({ error: "Invalid provider node type" }, { status: 400 });
  } catch (error) {
    if (error?.code === "PREFIX_TAKEN") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.log("Error creating provider node:", error);
    return NextResponse.json({ error: "Failed to create provider node" }, { status: 500 });
  }
}
