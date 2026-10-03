import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";
import {
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
} from "@/shared/constants/providers";
import { hasLiveModelResolver, resolveLiveModels } from "@/lib/providerModels/liveResolvers.js";

const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};

const createOpenAIModelsConfig = (url) => ({
  url,
  method: "GET",
  headers: { "Content-Type": "application/json" },
  authHeader: "Authorization",
  authPrefix: "Bearer ",
  parseResponse: parseOpenAIStyleModels,
});

// Provider models endpoints configuration
const PROVIDER_MODELS_CONFIG = {
  alicode: {
    url: "https://coding.dashscope.aliyuncs.com/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || [],
  },
  "alicode-intl": {
    url: "https://coding-intl.dashscope.aliyuncs.com/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || [],
  },
  "alims-intl": {
    url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || [],
  },
  "volcengine-ark": createOpenAIModelsConfig(
    "https://ark.cn-beijing.volces.com/api/coding/v3/models",
  ),
  byteplus: createOpenAIModelsConfig(
    "https://ark.ap-southeast.bytepluses.com/api/coding/v3/models",
  ),

  // OpenAI-compatible API key providers
  perplexity: createOpenAIModelsConfig("https://api.perplexity.ai/v1/models"),
  "perplexity-agent": createOpenAIModelsConfig("https://api.perplexity.ai/v1/models"),
  cohere: createOpenAIModelsConfig("https://api.cohere.ai/v1/models"),
  nebius: createOpenAIModelsConfig("https://api.studio.nebius.ai/v1/models"),
  siliconflow: createOpenAIModelsConfig("https://api.siliconflow.com/v1/models"),
  hyperbolic: createOpenAIModelsConfig("https://api.hyperbolic.xyz/v1/models"),
  nanobanana: createOpenAIModelsConfig("https://api.nanobananaapi.ai/v1/models"),
  chutes: createOpenAIModelsConfig("https://llm.chutes.ai/v1/models"),
  nvidia: createOpenAIModelsConfig("https://integrate.api.nvidia.com/v1/models"),
  assemblyai: createOpenAIModelsConfig("https://api.assemblyai.com/v1/models"),
  "vercel-ai-gateway": createOpenAIModelsConfig("https://ai-gateway.vercel.sh/v1/models"),
};

/**
 * GET /api/providers/[id]/models - Get models list from provider
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    if (isOpenAICompatibleProvider(connection.provider)) {
      const baseUrl = connection.providerSpecificData?.baseUrl;
      if (!baseUrl) {
        return NextResponse.json(
          { error: "No base URL configured for OpenAI compatible provider" },
          { status: 400 },
        );
      }
      const url = `${baseUrl.replace(/\/$/, "")}/models`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${connection.apiKey}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.log(`Error fetching models from ${connection.provider}:`, errorText);
        return NextResponse.json(
          { error: `Failed to fetch models: ${response.status}` },
          { status: response.status },
        );
      }

      const data = await response.json();
      const models = data.data || data.models || [];

      return NextResponse.json({
        provider: connection.provider,
        connectionId: connection.id,
        models,
      });
    }

    if (isAnthropicCompatibleProvider(connection.provider)) {
      let baseUrl = connection.providerSpecificData?.baseUrl;
      if (!baseUrl) {
        return NextResponse.json(
          { error: "No base URL configured for Anthropic compatible provider" },
          { status: 400 },
        );
      }

      baseUrl = baseUrl.replace(/\/$/, "");
      if (baseUrl.endsWith("/messages")) {
        baseUrl = baseUrl.slice(0, -9);
      }

      const url = `${baseUrl}/models`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": connection.apiKey,
          "anthropic-version": "2023-06-01",
          Authorization: `Bearer ${connection.apiKey}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.log(`Error fetching models from ${connection.provider}:`, errorText);
        return NextResponse.json(
          { error: `Failed to fetch models: ${response.status}` },
          { status: response.status },
        );
      }

      const data = await response.json();
      const models = data.data || data.models || [];

      return NextResponse.json({
        provider: connection.provider,
        connectionId: connection.id,
        models,
      });
    }

    // Live catalogs shared with /v1/models. Always 200: an empty or failed
    // fetch comes back as models: [] + warning so the dashboard keeps its
    // static list. Hidden entries are routable but not offered for selection.
    if (hasLiveModelResolver(connection.provider)) {
      const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1";
      const { models, warning } = await resolveLiveModels(connection, { forceRefresh });
      return NextResponse.json({
        provider: connection.provider,
        connectionId: connection.id,
        models: models.filter((m) => !m.hidden),
        ...(warning ? { warning } : {}),
      });
    }

    const config = PROVIDER_MODELS_CONFIG[connection.provider];
    if (!config) {
      return NextResponse.json(
        { error: `Provider ${connection.provider} does not support models listing` },
        { status: 400 },
      );
    }

    // Config-driven custom resolver path (OAuth refresh, non-OpenAI shape, etc.)
    if (typeof config.customResolver === "function") {
      const result = await config.customResolver(connection);
      if (result.error) {
        return NextResponse.json({ error: result.error }, { status: result.status || 500 });
      }
      return NextResponse.json({
        provider: connection.provider,
        connectionId: connection.id,
        models: result.models,
        ...(result.warning ? { warning: result.warning } : {}),
      });
    }

    // Get auth token
    const token =
      connection.providerSpecificData?.copilotToken || connection.accessToken || connection.apiKey;
    if (!token) {
      return NextResponse.json({ error: "No valid token found" }, { status: 401 });
    }

    const headers = { ...config.headers };
    if (config.authHeader) {
      headers[config.authHeader] = (config.authPrefix || "") + token;
    }

    const response = await fetch(config.url, { method: config.method, headers });

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`Error fetching models from ${connection.provider}:`, errorText);
      return NextResponse.json(
        { error: `Failed to fetch models: ${response.status}` },
        { status: response.status },
      );
    }

    const data = await response.json();
    const models = config.parseResponse(data);

    return NextResponse.json({
      provider: connection.provider,
      connectionId: connection.id,
      models,
    });
  } catch (error) {
    console.log("Error fetching provider models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}
