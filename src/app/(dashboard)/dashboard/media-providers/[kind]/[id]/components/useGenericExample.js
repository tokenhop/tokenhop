"use client";

import { useState, useEffect, useRef } from "react";
import {
  MEDIA_PROVIDER_KINDS,
  getProviderAlias,
  resolveProviderId,
} from "@/shared/constants/providers";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { createObjectUrlRegistry } from "@/shared/constants/playgroundUrls";
import { KIND_EXAMPLE_CONFIG } from "./exampleShared";
import {
  KIND_NEEDS_MODEL,
  getImageEditDefaults,
  toImagePreviewSrc,
  buildGenericModelFull,
  buildGenericRequestBody,
  buildGenericCurl,
  parseSseBlocks,
  maskB64,
} from "./genericExampleLogic";

/**
 * State, effects and handlers for `GenericExampleCard` (YAN-402). Keeps the
 * fetch/stream/blob behaviour of the original card; the component composes
 * this hook with `GenericExampleForm` and `GenericExampleResult`.
 */
export function useGenericExample(providerId, kind) {
  const providerAlias = getProviderAlias(providerId);
  const resolvedId = resolveProviderId(providerAlias);
  const safeProviderAlias = resolvedId === providerId ? providerAlias : providerId;
  const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kind);
  const exConfig = KIND_EXAMPLE_CONFIG[kind];
  const safeExConfig = exConfig || {};

  // Get models for this kind (e.g., type="image")
  const kindModels = getModelsByProviderId(providerId).filter((m) => getModelKind(m) === kind);
  // Kinds that need a model identifier in the request (image/video/music)
  const needsModel = KIND_NEEDS_MODEL.has(kind);
  const allowManualModel = needsModel && kindModels.length === 0;
  const [selectedModel, setSelectedModel] = useState(kindModels[0]?.id ?? "");
  const selectedModelObj = kindModels.find((m) => m.id === selectedModel);
  const supportsEdit = !!selectedModelObj?.capabilities?.includes("edit");
  const supportsMask = !!selectedModelObj?.capabilities?.includes("mask");

  const [input, setInput] = useState(safeExConfig.defaultInput || "");
  const [refImage, setRefImage] = useState("");
  const [maskImage, setMaskImage] = useState("");
  const [extraValues, setExtraValues] = useState(() =>
    (safeExConfig.extraFields || []).reduce((acc, f) => {
      acc[f.key] = f.default ?? "";
      return acc;
    }, {}),
  );
  const [apiKey, setApiKey] = useState("");
  const [useTunnel, setUseTunnel] = useState(false);
  const [localEndpoint, setLocalEndpoint] = useState("");
  const [tunnelEndpoint, setTunnelEndpoint] = useState("");
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState(null); // { stage, bytesReceived }
  const [partialImage, setPartialImage] = useState(null);
  const [imageOutputFormat, setImageOutputFormat] = useState("json"); // json | binary
  const [binaryImageUrl, setBinaryImageUrl] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [connections, setConnections] = useState([]);
  const [pinnedConnectionId, setPinnedConnectionId] = useState("");

  // Ref-tracked blob URL: the unmount cleanup revokes the live URL even
  // though React state is stale inside cleanup closures.
  const binaryUrlRef = useRef({ image: "", audio: "" });
  const [binaryUrls] = useState(() => createObjectUrlRegistry(binaryUrlRef));

  // Revoke the live blob URL on unmount via the ref (state is stale here).
  // biome-ignore lint/correctness/useExhaustiveDependencies: cleanup on unmount only
  useEffect(() => binaryUrls.revokeAll, []);

  useEffect(() => {
    setLocalEndpoint(window.location.origin);
    fetch("/api/keys")
      .then((r) => r.json())
      .then((d) => {
        setApiKey((d.keys || []).find((k) => k.isActive !== false)?.key || "");
      })
      .catch(() => {});
    fetch("/api/tunnel/status")
      .then((r) => r.json())
      .then((d) => {
        if (d.tunnel?.publicUrl) setTunnelEndpoint(d.tunnel.publicUrl);
      })
      .catch(() => {});
    // Load active connections of this provider for pinning
    fetch("/api/providers/client")
      .then((r) => r.json())
      .then((d) => {
        const conns = (d.connections || []).filter(
          (c) => c.provider === providerId && c.isActive !== false,
        );
        setConnections(conns);
      })
      .catch(() => {});
  }, [providerId]);

  const endpoint = useTunnel ? tunnelEndpoint : localEndpoint;
  const apiPath = kindConfig?.endpoint?.path ?? "";
  // webSearch/webFetch: use safeProviderAlias only. Other kinds: append model when present.
  const modelFull = buildGenericModelFull({
    alias: safeProviderAlias,
    needsModel,
    selectedModel,
    allowManualModel,
  });
  const imageEditDefaults = getImageEditDefaults(providerId, selectedModel);
  const effectiveRefImage = refImage.trim() || imageEditDefaults.image || "";
  const effectiveMaskImage = maskImage.trim() || imageEditDefaults.mask_image || "";
  const refImagePreviewSrc = toImagePreviewSrc(effectiveRefImage);
  const maskImagePreviewSrc = toImagePreviewSrc(effectiveMaskImage);

  const requestBody = buildGenericRequestBody({
    modelFull,
    input,
    bodyKey: safeExConfig.bodyKey,
    extraBody: safeExConfig.extraBody,
    extraValues,
    supportsEdit,
    supportsMask,
    effectiveRefImage,
    effectiveMaskImage,
  });

  // Streaming supported for codex image (Plus/Pro accounts) — disabled when binary output requested
  const wantBinary = kind === "image" && imageOutputFormat === "binary";
  const useStreaming = kind === "image" && providerId === "codex" && !wantBinary;
  const apiPathWithQuery = `${apiPath}${wantBinary ? "?response_format=binary" : ""}`;
  const curlSnippet = buildGenericCurl({
    method: kindConfig?.endpoint?.method ?? "POST",
    endpoint,
    apiPathWithQuery,
    apiKey,
    pinnedConnectionId,
    useStreaming,
    wantBinary,
    body: requestBody,
  });

  const handleRun = async () => {
    if (!input.trim() || !modelFull) return;
    setRunning(true);
    setError("");
    setResult(null);
    setProgress(null);
    setPartialImage(null);
    setBinaryImageUrl("");
    binaryUrls.clear();
    const start = Date.now();
    try {
      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      if (pinnedConnectionId) headers["x-connection-id"] = pinnedConnectionId;
      if (useStreaming) headers["Accept"] = "text/event-stream";
      const body = { ...requestBody, model: modelFull };
      const res = await fetch(`/api${apiPathWithQuery}`, {
        method: kindConfig.endpoint.method,
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error?.message || data?.error || `HTTP ${res.status}`);
        return;
      }
      const ctype = res.headers.get("content-type") || "";
      // Binary image response — convert to blob URL (registry revokes on replace/unmount)
      if (ctype.startsWith("image/")) {
        const blob = await res.blob();
        const objUrl = URL.createObjectURL(blob);
        binaryUrls.setImage(objUrl);
        setBinaryImageUrl(objUrl);
        setResult({
          data: { binary: true, mime: ctype, size: blob.size },
          latencyMs: Date.now() - start,
        });
        return;
      }
      const isSse = ctype.includes("text/event-stream");
      if (isSse && res.body) {
        // Parse SSE: progress / partial_image / done / error
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let finalData = null;
        let streamErr = null;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parsed = parseSseBlocks(buf);
          buf = parsed.rest;
          for (const { type, payload } of parsed.events) {
            if (type === "progress") setProgress(payload);
            else if (type === "partial_image") setPartialImage(payload);
            else if (type === "done") finalData = payload;
            else if (type === "error") streamErr = payload?.message || "Stream error";
          }
        }
        const latencyMs = Date.now() - start;
        if (streamErr) {
          setError(streamErr);
          return;
        }
        if (finalData) setResult({ data: finalData, latencyMs });
      } else {
        const data = await res.json();
        const latencyMs = Date.now() - start;
        setResult({ data, latencyMs });
      }
    } catch (e) {
      setError(e.message || "Network error");
    } finally {
      setRunning(false);
    }
  };

  const resultJson = result ? JSON.stringify(maskB64(result.data), null, 2) : "";

  return {
    kindConfig,
    exConfig,
    safeProviderAlias,
    kindModels,
    needsModel,
    allowManualModel,
    selectedModel,
    setSelectedModel,
    selectedModelObj,
    supportsEdit,
    supportsMask,
    input,
    setInput,
    refImage,
    setRefImage,
    maskImage,
    setMaskImage,
    extraValues,
    setExtraValues,
    apiKey,
    useTunnel,
    setUseTunnel,
    endpoint,
    tunnelEndpoint,
    result,
    progress,
    partialImage,
    imageOutputFormat,
    setImageOutputFormat,
    binaryImageUrl,
    running,
    error,
    connections,
    pinnedConnectionId,
    setPinnedConnectionId,
    refImagePreviewSrc,
    maskImagePreviewSrc,
    imageEditDefaults,
    useStreaming,
    modelFull,
    curlSnippet,
    resultJson,
    handleRun,
  };
}
