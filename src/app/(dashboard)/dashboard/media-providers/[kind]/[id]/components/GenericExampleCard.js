"use client";

import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { Button, Card, Callout, IconButton } from "@/shared/components";
import {
  MEDIA_PROVIDER_KINDS,
  getProviderAlias,
  resolveProviderId,
} from "@/shared/constants/providers";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import CopyStatus from "@/shared/components/CopyStatus";
import { createObjectUrlRegistry } from "@/shared/constants/playgroundUrls";
import {
  Row,
  KIND_EXAMPLE_CONFIG,
  controlClass,
  readonlyClass,
  codeBlockClass,
  eyebrowClass,
  tunnelToggleClass,
} from "./exampleShared";
import { maskPreviewApiKey, previewAuthHeader } from "@/shared/constants/previewAuth";

const CLOUDFLARE_TEST_IMAGE_URL = "https://pub-1fb693cb11cc46b2b2f656f51e015a2c.r2.dev/dog.png";
const CLOUDFLARE_TEST_MASK_URL = "https://pub-1fb693cb11cc46b2b2f656f51e015a2c.r2.dev/dog-mask.png";

function getImageEditDefaults(providerId, modelId) {
  if (providerId !== "cloudflare-ai") return {};
  if (modelId === "@cf/runwayml/stable-diffusion-v1-5-img2img") {
    return { image: CLOUDFLARE_TEST_IMAGE_URL };
  }
  if (modelId === "@cf/runwayml/stable-diffusion-v1-5-inpainting") {
    return { image: CLOUDFLARE_TEST_IMAGE_URL, mask_image: CLOUDFLARE_TEST_MASK_URL };
  }
  return {};
}

function toImagePreviewSrc(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";
  if (/^(data:image\/|https?:\/\/)/i.test(trimmed)) return trimmed;
  return `data:image/png;base64,${trimmed}`;
}

export function GenericExampleCard({ providerId, kind }) {
  const providerAlias = getProviderAlias(providerId);
  const resolvedId = resolveProviderId(providerAlias);
  const safeProviderAlias = resolvedId === providerId ? providerAlias : providerId;
  const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kind);
  const exConfig = KIND_EXAMPLE_CONFIG[kind];
  const safeExConfig = exConfig || {};

  // Get models for this kind (e.g., type="image")
  const kindModels = getModelsByProviderId(providerId).filter((m) => getModelKind(m) === kind);
  // Kinds that need a model identifier in the request (image/video/music)
  const KIND_NEEDS_MODEL = new Set(["image", "video", "music", "imageToText"]);
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
  const { copied: copiedCurl, error: errorCurl, copy: copyCurl } = useCopyToClipboard();
  const { copied: copiedRes, error: errorRes, copy: copyRes } = useCopyToClipboard();

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

  // Safe to early-return now that all hooks are declared
  if (!kindConfig || !exConfig) return null;

  const endpoint = useTunnel ? tunnelEndpoint : localEndpoint;
  const apiPath = kindConfig.endpoint.path;
  // webSearch/webFetch: use safeProviderAlias only. Other kinds: append model when present.
  const modelFull = !needsModel
    ? safeProviderAlias
    : selectedModel
      ? `${safeProviderAlias}/${selectedModel}`
      : allowManualModel
        ? ""
        : safeProviderAlias;
  const imageEditDefaults = getImageEditDefaults(providerId, selectedModel);
  const effectiveRefImage = refImage.trim() || imageEditDefaults.image || "";
  const effectiveMaskImage = maskImage.trim() || imageEditDefaults.mask_image || "";
  const refImagePreviewSrc = toImagePreviewSrc(effectiveRefImage);
  const maskImagePreviewSrc = toImagePreviewSrc(effectiveMaskImage);

  // Build request body with optional extra fields (only non-empty values)
  const extraBodyFromFields = Object.entries(extraValues).reduce((acc, [k, v]) => {
    if (v === "" || v === null || v === undefined) return acc;
    if (typeof v === "number" && Number.isNaN(v)) return acc;
    acc[k] = v;
    return acc;
  }, {});
  const requestBody = {
    model: modelFull,
    [exConfig.bodyKey]: input,
    ...exConfig.extraBody,
    ...extraBodyFromFields,
    ...(supportsEdit && effectiveRefImage ? { image: effectiveRefImage } : {}),
    ...(supportsMask && effectiveMaskImage ? { mask_image: effectiveMaskImage } : {}),
  };

  // Streaming supported for codex image (Plus/Pro accounts) — disabled when binary output requested
  const wantBinary = kind === "image" && imageOutputFormat === "binary";
  const useStreaming = kind === "image" && providerId === "codex" && !wantBinary;
  const apiPathWithQuery = `${apiPath}${wantBinary ? "?response_format=binary" : ""}`;
  // Preview-safe: rendered/copied cURL always shows Bearer YOUR_KEY.
  // The live key is only sent in the fetch Authorization header below.
  const headersPreview = `-H "Content-Type: application/json" \\\n  -H "Authorization: ${previewAuthHeader(apiKey)}"${pinnedConnectionId ? ` \\\n  -H "x-connection-id: ${pinnedConnectionId}"` : ""}${useStreaming ? ` \\\n  -H "Accept: text/event-stream"` : ""}`;
  const curlSnippet = `curl -X ${kindConfig.endpoint.method} ${endpoint}${apiPathWithQuery} \\
  ${headersPreview.replace(/\\\n {2}/g, "\\\n  ")} \\
  -d '${JSON.stringify(requestBody)}'${wantBinary ? " \\\n  --output image.png" : ""}`;

  const handleRun = async () => {
    if (!input.trim() || !modelFull) return;
    setRunning(true);
    setError("");
    setResult(null);
    setProgress(null);
    setPartialImage(null);
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
          let sep;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            let evt = null,
              dataStr = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) evt = line.slice(6).trim();
              else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
            }
            if (!evt) continue;
            try {
              const payload = dataStr ? JSON.parse(dataStr) : {};
              if (evt === "progress") setProgress(payload);
              else if (evt === "partial_image") setPartialImage(payload);
              else if (evt === "done") finalData = payload;
              else if (evt === "error") streamErr = payload?.message || "Stream error";
            } catch {}
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

  // Mask large b64_json strings in JSON view to keep it readable
  const maskB64 = (obj) => {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(maskB64);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] =
        k === "b64_json" && typeof v === "string" && v.length > 100
          ? `<${v.length} chars base64>`
          : maskB64(v);
    }
    return out;
  };
  const resultJson = result ? JSON.stringify(maskB64(result.data), null, 2) : "";

  return (
    <Card
      title={`${safeProviderAlias} example`}
      subtitle={`Run a live ${kindConfig.label.toLowerCase()} request against this provider.`}
      icon="labs"
    >
      <div className="flex flex-col gap-2.5">
        {/* Model selector — dropdown if presets exist, else manual input for media kinds */}
        {kindModels.length > 0 ? (
          <Row label="Model">
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              aria-label="Model"
              className={controlClass}
            >
              {kindModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.id}
                </option>
              ))}
            </select>
          </Row>
        ) : allowManualModel ? (
          <Row label="Model">
            <input
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              placeholder="Enter model id (provider-specific)"
              aria-label="Model"
              className={`${controlClass} font-mono`}
            />
          </Row>
        ) : null}

        {/* Endpoint */}
        <Row label="Endpoint">
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <span className={readonlyClass} dir="ltr">
              {endpoint}
              {apiPath}
            </span>
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

        {/* API Key */}
        <Row label="API Key">
          <span className={readonlyClass} dir="ltr">
            {apiKey ? (
              maskPreviewApiKey(apiKey)
            ) : (
              <span className="text-subtle italic">No key configured</span>
            )}
          </span>
        </Row>

        {/* Connection picker - only show when 2+ connections (or any with email) */}
        {connections.length > 0 && (
          <Row label="Connection">
            <select
              value={pinnedConnectionId}
              onChange={(e) => setPinnedConnectionId(e.target.value)}
              aria-label="Connection"
              className={controlClass}
            >
              <option value="">Auto (by priority)</option>
              {connections.map((c) => {
                const plan = c.providerSpecificData?.chatgptPlanType;
                const label = c.email || c.name || c.id.slice(0, 8);
                return (
                  <option key={c.id} value={c.id}>
                    {label}
                    {plan ? ` [${plan}]` : ""}
                  </option>
                );
              })}
            </select>
          </Row>
        )}

        {/* Input */}
        <Row label={exConfig.inputLabel}>
          <div className="relative">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={exConfig.inputPlaceholder}
              aria-label={exConfig.inputLabel}
              className={`${controlClass} pe-11`}
            />
            {input && (
              <IconButton
                icon="close"
                label={`Clear ${exConfig.inputLabel.toLowerCase()}`}
                onClick={() => setInput("")}
                className="absolute end-1 top-1/2 size-9 -translate-y-1/2 border-0 bg-transparent"
              />
            )}
          </div>
        </Row>

        {/* Reference image (only for edit-capable image models) */}
        {supportsEdit && (
          <Row label="Ref Image (URL)">
            <div className="flex flex-col gap-2">
              <div className="relative">
                <input
                  value={refImage}
                  onChange={(e) => setRefImage(e.target.value)}
                  placeholder={imageEditDefaults.image || "https://example.com/source.png"}
                  aria-label="Reference image URL"
                  className={`${controlClass} pe-11`}
                  dir="ltr"
                />
                {refImage && (
                  <IconButton
                    icon="close"
                    label="Clear reference image"
                    onClick={() => setRefImage("")}
                    className="absolute end-1 top-1/2 size-9 -translate-y-1/2 border-0 bg-transparent"
                  />
                )}
              </div>
              {refImagePreviewSrc && (
                <img
                  src={refImagePreviewSrc}
                  alt="Reference"
                  className="max-h-40 rounded-xl border border-line bg-raised object-contain"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                  onLoad={(e) => {
                    e.currentTarget.style.display = "block";
                  }}
                  loading="lazy"
                  decoding="async"
                />
              )}
            </div>
          </Row>
        )}

        {supportsMask && (
          <Row label="Mask (URL)">
            <div className="flex flex-col gap-2">
              <div className="relative">
                <input
                  value={maskImage}
                  onChange={(e) => setMaskImage(e.target.value)}
                  placeholder={imageEditDefaults.mask_image || "https://example.com/mask.png"}
                  aria-label="Mask image URL"
                  className={`${controlClass} pe-11`}
                  dir="ltr"
                />
                {maskImage && (
                  <IconButton
                    icon="close"
                    label="Clear mask image"
                    onClick={() => setMaskImage("")}
                    className="absolute end-1 top-1/2 size-9 -translate-y-1/2 border-0 bg-transparent"
                  />
                )}
              </div>
              {maskImagePreviewSrc && (
                <img
                  src={maskImagePreviewSrc}
                  alt="Mask"
                  className="max-h-40 rounded-xl border border-line bg-raised object-contain"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                  onLoad={(e) => {
                    e.currentTarget.style.display = "block";
                  }}
                  loading="lazy"
                  decoding="async"
                />
              )}
            </div>
          </Row>
        )}

        {/* Extra fields — for kinds without model concept (webSearch/webFetch), show all; otherwise filter by model.params */}
        {(exConfig.extraFields || [])
          .filter(
            (f) =>
              kindModels.length === 0 ||
              (Array.isArray(selectedModelObj?.params) && selectedModelObj.params.includes(f.key)),
          )
          .map((f) => (
            <Row key={f.key} label={f.label}>
              {f.type === "select" ? (
                <select
                  value={extraValues[f.key] ?? ""}
                  onChange={(e) => setExtraValues((s) => ({ ...s, [f.key]: e.target.value }))}
                  aria-label={f.label}
                  className={controlClass}
                >
                  {(f.options || []).map((opt) => (
                    <option key={opt} value={opt}>
                      {opt === "" ? "(default)" : opt}
                    </option>
                  ))}
                </select>
              ) : f.type === "text" ? (
                <input
                  type="text"
                  value={extraValues[f.key] ?? ""}
                  placeholder={f.placeholder}
                  onChange={(e) => setExtraValues((s) => ({ ...s, [f.key]: e.target.value }))}
                  aria-label={f.label}
                  className={controlClass}
                />
              ) : (
                <input
                  type="number"
                  value={extraValues[f.key] ?? ""}
                  min={f.min}
                  max={f.max}
                  onChange={(e) =>
                    setExtraValues((s) => ({
                      ...s,
                      [f.key]: e.target.value === "" ? "" : Number(e.target.value),
                    }))
                  }
                  aria-label={f.label}
                  className={controlClass}
                />
              )}
            </Row>
          ))}

        {/* Output Format toggle (image only) — last */}
        {kind === "image" && (
          <Row label="Output Format">
            <select
              value={imageOutputFormat}
              onChange={(e) => setImageOutputFormat(e.target.value)}
              aria-label="Output Format"
              className={controlClass}
            >
              <option value="json">JSON (Base64)</option>
              <option value="binary">Binary File</option>
            </select>
          </Row>
        )}

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

        {/* Streaming progress */}
        {(running || progress) && useStreaming && (
          <div
            className="flex flex-col gap-2 rounded-xl border border-line bg-raised px-4 py-3 sm:flex-row sm:items-center sm:gap-3"
            role="status"
          >
            <span
              className={`material-symbols-outlined text-[16px] text-coral-ink ${running ? "animate-spin" : ""}`}
              aria-hidden="true"
            >
              {running ? "progress_activity" : "check_circle"}
            </span>
            <span className="text-xs text-muted">
              {progress?.stage || "starting"}
              {!running && progress?.bytesReceived
                ? ` · ${(progress.bytesReceived / 1024).toFixed(1)} KB`
                : ""}
            </span>
          </div>
        )}

        {/* Partial image preview (codex stream) */}
        {partialImage?.b64_json && !result && (
          <div>
            <span className={eyebrowClass}>Partial preview</span>
            <img
              src={`data:image/png;base64,${partialImage.b64_json}`}
              alt="Partial"
              className="mt-1.5 max-w-full rounded-xl border border-line opacity-80"
              loading="lazy"
              decoding="async"
            />
          </div>
        )}

        {/* Error */}
        {error && (
          <Callout variant="err" title="Request failed">
            {error}
          </Callout>
        )}

        {/* Response */}
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
            {result ? resultJson : (exConfig.defaultResponse ?? "")}
          </pre>
          {kind === "image" && (binaryImageUrl || result?.data?.data?.[0]) && (
            <div className="mt-2">
              <div className="mb-1.5 flex items-center justify-end">
                <a
                  href={
                    binaryImageUrl ||
                    (result?.data?.data?.[0]?.b64_json
                      ? `data:image/png;base64,${result.data.data[0].b64_json}`
                      : result?.data?.data?.[0]?.url || "")
                  }
                  download="image.png"
                  className="inline-flex min-h-10 items-center gap-1 rounded-lg text-xs text-muted transition-colors hover:text-text"
                >
                  <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                    download
                  </span>
                  Download
                </a>
              </div>
              <img
                src={
                  binaryImageUrl ||
                  (result?.data?.data?.[0]?.b64_json
                    ? `data:image/png;base64,${result.data.data[0].b64_json}`
                    : result?.data?.data?.[0]?.url)
                }
                alt="Generated"
                className="max-w-full rounded-xl border border-line"
                loading="lazy"
                decoding="async"
              />
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

GenericExampleCard.propTypes = {
  providerId: PropTypes.string.isRequired,
  kind: PropTypes.string.isRequired,
};
