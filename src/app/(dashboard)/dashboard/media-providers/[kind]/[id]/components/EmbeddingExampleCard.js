"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Button, Card, IconButton, Callout } from "@/shared/components";
import { getProviderAlias, isCustomEmbeddingProvider } from "@/shared/constants/providers";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import CopyStatus from "@/shared/components/CopyStatus";
import {
  Row,
  controlClass,
  codeBlockClass,
  eyebrowClass,
  tunnelToggleClass,
} from "./exampleShared";
import { maskPreviewApiKey, previewAuthHeader } from "@/shared/constants/previewAuth";

const DEFAULT_RESPONSE_EXAMPLE = `{
  "object": "list",
  "data": [{
    "object": "embedding",
    "index": 0,
    "embedding": [0.002301, -0.019212, 0.004815, -0.031249, ...]
  }],
  "model": "...",
  "usage": { "prompt_tokens": 9, "total_tokens": 9 }
}`;

export function EmbeddingExampleCard({ providerId, customAlias }) {
  const isCustom = isCustomEmbeddingProvider(providerId);
  const providerAlias = isCustom ? customAlias || providerId : getProviderAlias(providerId);
  const embeddingModels = isCustom
    ? []
    : getModelsByProviderId(providerId).filter((m) => getModelKind(m) === "embedding");

  const [selectedModel, setSelectedModel] = useState(embeddingModels[0]?.id ?? "");
  const [input, setInput] = useState("The quick brown fox jumps over the lazy dog");
  const [dimensions, setDimensions] = useState("");
  // Loaded key never enters the DOM: the input only holds a manual override.
  const [loadedKey, setLoadedKey] = useState("");
  const [keyOverride, setKeyOverride] = useState("");
  const apiKey = keyOverride || loadedKey;
  const [useTunnel, setUseTunnel] = useState(false);
  const [localEndpoint, setLocalEndpoint] = useState("");
  const [tunnelEndpoint, setTunnelEndpoint] = useState("");
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const { copied: copiedCurl, error: errorCurl, copy: copyCurl } = useCopyToClipboard();
  const { copied: copiedRes, error: errorRes, copy: copyRes } = useCopyToClipboard();

  useEffect(() => {
    setLocalEndpoint(window.location.origin);
    fetch("/api/keys")
      .then((r) => r.json())
      .then((d) => {
        setLoadedKey((d.keys || []).find((k) => k.isActive !== false)?.key || "");
      })
      .catch(() => {});
    fetch("/api/tunnel/status")
      .then((r) => r.json())
      .then((d) => {
        if (d.tunnel?.publicUrl) setTunnelEndpoint(d.tunnel.publicUrl);
      })
      .catch(() => {});
  }, []);

  const endpoint = useTunnel ? tunnelEndpoint : localEndpoint;
  const modelFull = selectedModel ? `${providerAlias}/${selectedModel}` : "";

  // Build request body — include dimensions only if user provided a positive number
  const buildBody = () => {
    const body = { model: modelFull, input: input.trim() };
    const dim = Number(dimensions);
    if (dimensions && Number.isFinite(dim) && dim > 0) body.dimensions = dim;
    return body;
  };

  // Preview-safe: rendered/copied cURL always shows Bearer YOUR_KEY.
  // The live key is only sent in the fetch Authorization header below.
  const curlSnippet = `curl -X POST ${endpoint}/v1/embeddings \\
  -H "Content-Type: application/json" \\
  -H "Authorization: ${previewAuthHeader(apiKey)}" \\
  -d '${JSON.stringify(buildBody())}'`;

  const handleRun = async () => {
    if (!input.trim() || !modelFull) return;
    setRunning(true);
    setError("");
    setResult(null);
    const start = Date.now();
    try {
      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const res = await fetch("/api/v1/embeddings", {
        method: "POST",
        headers,
        body: JSON.stringify(buildBody()),
      });
      const latencyMs = Date.now() - start;
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error?.message || data?.error || `HTTP ${res.status}`);
        return;
      }
      setResult({ data, latencyMs });
    } catch (e) {
      setError(e.message || "Network error");
    } finally {
      setRunning(false);
    }
  };

  // Compact embedding array: first 4 values + count
  const formatResultJson = (data) => {
    if (!data) return DEFAULT_RESPONSE_EXAMPLE;
    const clone = JSON.parse(JSON.stringify(data));
    (clone.data || []).forEach((item) => {
      if (Array.isArray(item.embedding) && item.embedding.length > 4) {
        item.embedding = [
          ...item.embedding.slice(0, 4).map((v) => parseFloat(v.toFixed(6))),
          `... (${item.embedding.length} dims)`,
        ];
      }
    });
    return JSON.stringify(clone, null, 2);
  };

  const resultJson = result ? JSON.stringify(result.data, null, 2) : "";

  return (
    <Card
      title={`${providerAlias} example`}
      subtitle="Run a live embeddings request against this provider."
      icon="labs"
    >
      <div className="flex flex-col gap-2.5">
        {/* Model — text input for custom node, dropdown otherwise */}
        <Row label="Model">
          {isCustom ? (
            <input
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              placeholder="e.g. voyage-3, embed-english-v3.0, text-embedding-3-small"
              aria-label="Model"
              className={`${controlClass} font-mono`}
            />
          ) : (
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              aria-label="Model"
              className={controlClass}
            >
              {embeddingModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.id}
                </option>
              ))}
            </select>
          )}
        </Row>

        {/* Endpoint */}
        <Row label="Endpoint">
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <input
              value={endpoint}
              onChange={(e) =>
                useTunnel ? setTunnelEndpoint(e.target.value) : setLocalEndpoint(e.target.value)
              }
              aria-label="Endpoint"
              className={`${controlClass} min-w-0 flex-1 font-mono`}
              placeholder="http://localhost:3000"
            />
            {/* Tunnel toggle — only show if tunnel URL is available */}
            {tunnelEndpoint && (
              <button
                type="button"
                onClick={() => setUseTunnel((v) => !v)}
                title={useTunnel ? "Using tunnel" : "Using local"}
                aria-pressed={useTunnel}
                className={tunnelToggleClass(useTunnel)}
              >
                <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                  wifi_tethering
                </span>
                Tunnel
              </button>
            )}
          </div>
        </Row>

        {/* API key */}
        <Row label="API key">
          <input
            type="password"
            value={keyOverride}
            onChange={(e) => setKeyOverride(e.target.value)}
            placeholder={loadedKey ? maskPreviewApiKey(loadedKey) : "sk-..."}
            aria-label="API key"
            autoComplete="off"
            className={`${controlClass} font-mono`}
          />
        </Row>

        {/* Input */}
        <Row label="Input">
          <div className="relative">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              aria-label="Input"
              className={`${controlClass} pe-11`}
            />
            {input && (
              <IconButton
                icon="close"
                label="Clear input"
                onClick={() => setInput("")}
                className="absolute end-1 top-1/2 size-9 -translate-y-1/2 border-0 bg-transparent"
              />
            )}
          </div>
        </Row>

        {/* Dimensions (optional) — truncate embedding vector length */}
        <Row label="Dimensions">
          <input
            type="number"
            min="1"
            value={dimensions}
            onChange={(e) => setDimensions(e.target.value)}
            placeholder="optional, e.g. 512, 1024 (leave empty for default)"
            aria-label="Dimensions"
            className={controlClass}
          />
        </Row>

        {/* Curl + Run */}
        <div className="mt-1">
          <div className="mb-1.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className={eyebrowClass}>Request</span>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              <Button
                size="sm"
                variant="ghost"
                icon={copiedCurl ? "check" : errorCurl ? "error" : "content_copy"}
                onClick={() => copyCurl(curlSnippet)}
              >
                {copiedCurl ? "Copied" : errorCurl ? "Couldn't copy" : "Copy"}
              </Button>
              <CopyStatus copied={copiedCurl} error={errorCurl} />
              <Button
                size="sm"
                variant="primary"
                icon="play_arrow"
                onClick={handleRun}
                disabled={running || !input.trim() || !modelFull}
                loading={running}
              >
                {running ? "Running..." : "Run"}
              </Button>
            </div>
          </div>
          <pre className={codeBlockClass} dir="ltr">
            {curlSnippet}
          </pre>
        </div>

        {/* Error */}
        {error && (
          <Callout variant="err" title="Request failed">
            {error}
          </Callout>
        )}

        {/* Response — default example or real result */}
        <div>
          <div className="mb-1.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className={eyebrowClass}>
              Response{" "}
              {result && (
                <span className="font-mono text-xs font-normal normal-case text-muted">
                  ⚡ {result.latencyMs}ms
                </span>
              )}
            </span>
            {result && (
              <Button
                size="sm"
                variant="ghost"
                icon={copiedRes ? "check" : errorRes ? "error" : "content_copy"}
                onClick={() => copyRes(resultJson)}
              >
                {copiedRes ? "Copied" : errorRes ? "Couldn't copy" : "Copy"}
              </Button>
            )}
            <CopyStatus copied={copiedRes} error={errorRes} />
          </div>
          <pre className={`${codeBlockClass} opacity-80`} dir="ltr">
            {formatResultJson(result?.data)}
          </pre>
        </div>
      </div>
    </Card>
  );
}

EmbeddingExampleCard.propTypes = {
  providerId: PropTypes.string.isRequired,
  customAlias: PropTypes.string,
};
