"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Button, Card, Callout } from "@/shared/components";
import { getProviderAlias } from "@/shared/constants/providers";
import { getModelKind } from "@/shared/constants/models";
import { getModelsByProviderId } from "@/shared/constants/models";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import CopyStatus from "@/shared/components/CopyStatus";
import {
  Row,
  controlClass,
  readonlyClass,
  codeBlockClass,
  eyebrowClass,
  tunnelToggleClass,
} from "./exampleShared";
import { maskPreviewApiKey, previewAuthHeader } from "@/shared/constants/previewAuth";

export function SttExampleCard({ providerId }) {
  const providerAlias = getProviderAlias(providerId);
  const builtinSttModels = getModelsByProviderId(providerId).filter(
    (m) => getModelKind(m) === "stt",
  );
  const [customSttModels, setCustomSttModels] = useState([]);
  const sttModels = [...builtinSttModels, ...customSttModels];

  const [selectedModel, setSelectedModel] = useState(builtinSttModels[0]?.id ?? "");
  const selectedModelObj = sttModels.find((m) => m.id === selectedModel);
  const allowedParams = Array.isArray(selectedModelObj?.params) ? selectedModelObj.params : [];

  const [audioFile, setAudioFile] = useState(null);
  const [language, setLanguage] = useState("");
  const [prompt, setPrompt] = useState("");
  const [responseFormat, setResponseFormat] = useState("json");
  const [temperature, setTemperature] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [useTunnel, setUseTunnel] = useState(false);
  const [localEndpoint, setLocalEndpoint] = useState("");
  const [tunnelEndpoint, setTunnelEndpoint] = useState("");
  const [result, setResult] = useState(null);
  const [latency, setLatency] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const { copied: copiedCurl, error: errorCurl, copy: copyCurl } = useCopyToClipboard();
  const { copied: copiedRes, error: errorRes, copy: copyRes } = useCopyToClipboard();

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
    const loadCustom = () => {
      fetch("/api/models/custom", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          const list = (d.models || []).filter(
            (m) => getModelKind(m) === "stt" && m.providerAlias === providerAlias,
          );
          setCustomSttModels(list);
        })
        .catch(() => {});
    };
    loadCustom();
    window.addEventListener("focus", loadCustom);
    window.addEventListener("customModelChanged", loadCustom);
    return () => {
      window.removeEventListener("focus", loadCustom);
      window.removeEventListener("customModelChanged", loadCustom);
    };
  }, [providerAlias]);

  const endpoint = useTunnel ? tunnelEndpoint : localEndpoint;
  const modelFull = selectedModel ? `${providerAlias}/${selectedModel}` : "";

  // Preview-safe: rendered/copied cURL always shows Bearer YOUR_KEY.
  // The live key is only sent in the fetch Authorization header below.
  const curlSnippet = `curl -X POST ${endpoint}/v1/audio/transcriptions \\
  -H "Authorization: ${previewAuthHeader(apiKey)}" \\
  -F "file=@${audioFile?.name || "audio.mp3"}" \\
  -F "model=${modelFull}"${allowedParams.includes("language") && language ? ` \\\n  -F "language=${language}"` : ""}${allowedParams.includes("response_format") ? ` \\\n  -F "response_format=${responseFormat}"` : ""}${allowedParams.includes("temperature") && temperature ? ` \\\n  -F "temperature=${temperature}"` : ""}${allowedParams.includes("prompt") && prompt ? ` \\\n  -F "prompt=${prompt}"` : ""}`;

  const handleRun = async () => {
    if (!audioFile || !modelFull) return;
    setRunning(true);
    setError("");
    setResult(null);
    const start = Date.now();
    try {
      const fd = new FormData();
      fd.append("file", audioFile);
      fd.append("model", modelFull);
      if (allowedParams.includes("language") && language) fd.append("language", language);
      if (allowedParams.includes("response_format")) fd.append("response_format", responseFormat);
      if (allowedParams.includes("temperature") && temperature)
        fd.append("temperature", temperature);
      if (allowedParams.includes("prompt") && prompt) fd.append("prompt", prompt);

      const headers = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const res = await fetch("/api/v1/audio/transcriptions", {
        method: "POST",
        headers,
        body: fd,
      });
      setLatency(Date.now() - start);
      const ct = res.headers.get("content-type") || "";
      const data = ct.includes("application/json") ? await res.json() : await res.text();
      if (!res.ok) {
        setError(data?.error?.message || data?.error || data || `HTTP ${res.status}`);
        return;
      }
      setResult(data);
    } catch (e) {
      setError(e.message || "Network error");
    } finally {
      setRunning(false);
    }
  };

  const resultStr =
    typeof result === "string"
      ? result
      : result
        ? JSON.stringify(result, null, 2)
        : `{\n  "text": "Hello world..."\n}`;

  return (
    <Card
      title={`${providerAlias} example`}
      subtitle="Upload audio and run a live transcription against this provider."
      icon="labs"
    >
      <div className="flex flex-col gap-2.5">
        {/* Model */}
        {sttModels.length > 0 ? (
          <Row label="Model">
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              aria-label="Model"
              className={controlClass}
            >
              {sttModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.id}
                </option>
              ))}
            </select>
          </Row>
        ) : (
          <Row label="Model">
            <input
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              placeholder="Enter model id"
              aria-label="Model"
              className={`${controlClass} font-mono`}
            />
          </Row>
        )}

        {/* Endpoint */}
        <Row label="Endpoint">
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <span className={readonlyClass} dir="ltr">
              {endpoint}/v1/audio/transcriptions
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

        {/* API key */}
        <Row label="API key">
          <span className={readonlyClass} dir="ltr">
            {apiKey ? (
              maskPreviewApiKey(apiKey)
            ) : (
              <span className="text-subtle italic">No key configured</span>
            )}
          </span>
        </Row>

        {/* Audio file */}
        <Row label="Audio file">
          <div className="flex flex-col gap-2">
            <input
              type="file"
              accept="audio/*,video/mp4,.m4a,.mp3,.wav,.ogg,.flac,.webm,.opus"
              onChange={(e) => setAudioFile(e.target.files?.[0] || null)}
              aria-label="Audio file"
              className="w-full text-xs text-muted file:me-2 file:cursor-pointer file:rounded-lg file:border file:border-line file:bg-raised file:px-2.5 file:py-1 file:text-text hover:file:bg-line/60"
            />
            {audioFile && (
              <span className="font-mono text-xs text-muted" dir="ltr">
                {audioFile.name} · {(audioFile.size / 1024).toFixed(1)} KB
              </span>
            )}
          </div>
        </Row>

        {/* Language (if model supports) */}
        {allowedParams.includes("language") && (
          <Row label="Language">
            <input
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="e.g. en, vi, ja (auto-detect if empty)"
              aria-label="Language"
              className={`${controlClass} font-mono`}
            />
          </Row>
        )}

        {/* Prompt (if model supports) */}
        {allowedParams.includes("prompt") && (
          <Row label="Prompt">
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="optional context to improve accuracy"
              aria-label="Prompt"
              className={controlClass}
            />
          </Row>
        )}

        {/* Temperature (if model supports) */}
        {allowedParams.includes("temperature") && (
          <Row label="Temperature">
            <input
              type="number"
              step="0.1"
              min="0"
              max="1"
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
              placeholder="0 - 1 (default 0)"
              aria-label="Temperature"
              className={controlClass}
            />
          </Row>
        )}

        {/* Response format (if model supports) */}
        {allowedParams.includes("response_format") && (
          <Row label="Response format">
            <select
              value={responseFormat}
              onChange={(e) => setResponseFormat(e.target.value)}
              aria-label="Response format"
              className={controlClass}
            >
              <option value="json">json</option>
              <option value="text">text</option>
              <option value="srt">srt</option>
              <option value="verbose_json">verbose_json</option>
              <option value="vtt">vtt</option>
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
                disabled={running || !audioFile || !modelFull}
                loading={running}
              >
                {running ? "Transcribing..." : "Run"}
              </Button>
            </div>
          </div>
          <pre className={codeBlockClass} dir="ltr">
            {curlSnippet}
          </pre>
        </div>

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
              {result && latency && (
                <span className="font-mono text-xs font-normal normal-case text-muted">
                  ⚡ {latency}ms
                </span>
              )}
            </span>
            {result && (
              <Button
                size="sm"
                variant="ghost"
                icon={copiedRes ? "check" : errorRes ? "error" : "content_copy"}
                onClick={() => copyRes(resultStr)}
              >
                {copiedRes ? "Copied" : errorRes ? "Couldn't copy" : "Copy"}
              </Button>
            )}
            <CopyStatus copied={copiedRes} error={errorRes} />
          </div>
          <pre className={`${codeBlockClass} opacity-80`} dir="ltr">
            {resultStr}
          </pre>
        </div>
      </div>
    </Card>
  );
}

SttExampleCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
