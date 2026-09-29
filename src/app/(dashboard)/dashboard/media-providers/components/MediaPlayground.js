"use client";

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Button, Card, Field, SegmentedControl, Select, Callout } from "@/shared/components";
import { MEDIA_PROVIDER_KINDS, resolveProviderId } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import CopyStatus from "@/shared/components/CopyStatus";
import { buildPlaygroundCurl } from "@/shared/constants/mediaStatus";
import { createObjectUrlRegistry } from "@/shared/constants/playgroundUrls";
import {
  controlClass,
  codeBlockClass,
  eyebrowClass,
} from "../[kind]/[id]/components/exampleShared";
import {
  playgroundDefaults,
  playgroundModelOptions,
  resolvePlaygroundModel,
  buildPlaygroundBody,
  buildSttFormData,
  sttFormFields,
  playgroundHeaders,
  playgroundPreviews,
} from "./playgroundLogic";
import { PlaygroundKindFields, PlaygroundResult } from "./PlaygroundFields";

/**
 * "Try it" playground aside panel (and Drawer content on narrow widths).
 * Parity with the existing runners across all kinds (image, tts, stt, embedding, video, web).
 *
 * @param {object} props
 * @param {string} props.kind Current media kind.
 * @param {Array<object>} [props.connections=[]] Active provider connections.
 * @param {string} [props.className]
 */
export function MediaPlayground({ kind, connections = [], className = "" }) {
  const defaults = playgroundDefaults(kind);
  const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kind);

  const [mode, setMode] = useState("form"); // "form" | "curl"
  const [model, setModel] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [input, setInput] = useState(defaults.defaultInput);
  const [apiKey, setApiKey] = useState("");
  const [localOrigin, setLocalOrigin] = useState("");

  // Kind-specific parameters (only rendered for the matching kind below)
  const [imageSize, setImageSize] = useState("1024x1024");
  const [dimensions, setDimensions] = useState("");
  const [ttsVoice, setTtsVoice] = useState("alloy");
  const [ttsLanguage, setTtsLanguage] = useState("");
  const [ttsStyle, setTtsStyle] = useState("");
  const [sttFile, setSttFile] = useState(null);
  const [sttLanguage, setSttLanguage] = useState("");
  const [sttTemp, setSttTemp] = useState("");
  const [sttFormat, setSttFormat] = useState("json");
  const [refImage, setRefImage] = useState("");
  const [maskImage, setMaskImage] = useState("");

  // Execution state
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [, forcePreviewRender] = useState(0);

  // Ref-tracked object URLs: refs always hold the live URLs, so the unmount
  // cleanup revokes the active blobs even though state is stale in closures.
  // The registry mutates the ref directly; forcePreviewRender re-renders so
  // the preview reads the live URLs. The registry is memoized so the unmount
  // effect below runs exactly once.
  const objectUrlsRef = useRef({ image: "", audio: "" });
  const [objectUrls] = useState(() => createObjectUrlRegistry(objectUrlsRef));
  const rerenderPreviews = () => forcePreviewRender((n) => n + 1);
  const setTrackedImageUrl = (next) => {
    objectUrls.setImage(next);
    rerenderPreviews();
  };
  const setTrackedAudioUrl = (next) => {
    objectUrls.setAudio(next);
    rerenderPreviews();
  };
  const clearTrackedUrls = () => {
    objectUrls.clear();
    rerenderPreviews();
  };
  const [latency, setLatency] = useState(null);

  const { copied: copiedCurl, error: errorCurl, copy: copyCurl } = useCopyToClipboard();
  const { copied: copiedRes, error: errorRes, copy: copyRes } = useCopyToClipboard();

  useEffect(() => {
    setLocalOrigin(window.location.origin);
    fetch("/api/keys")
      .then((r) => r.json())
      .then((d) => {
        setApiKey((d.keys || []).find((k) => k.isActive !== false)?.key || "");
      })
      .catch(() => {});
  }, []);

  // Update default input when kind changes; revoke object URLs before clearing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on kind change only
  useEffect(() => {
    setInput(defaults.defaultInput);
    setResult(null);
    clearTrackedUrls();
    setError("");
    setLatency(null);
  }, [kind]);

  // Revoke the live object URLs on unmount via the ref (state is stale here).
  // biome-ignore lint/correctness/useExhaustiveDependencies: cleanup on unmount only
  useEffect(() => objectUrls.revokeAll, []);

  // Compute model choices for this kind
  const availableModels = playgroundModelOptions(kind);

  // Auto-select first model if not set or invalid
  // biome-ignore lint/correctness/useExhaustiveDependencies: updates model selection when kind models list changes
  useEffect(() => {
    setModel((current) => resolvePlaygroundModel(current, availableModels));
  }, [kind]);

  // Filter connections belonging to the selected model's provider.
  // Model values use provider aliases; resolve to raw ids to match c.provider.
  const selectedProviderId = model ? resolveProviderId(model.split("/")[0]) : "";
  const providerConnections = (connections || []).filter(
    (c) => c && c.provider === selectedProviderId && c.isActive !== false,
  );

  const fields = {
    kind,
    model,
    input,
    imageSize,
    dimensions,
    ttsVoice,
    ttsLanguage,
    ttsStyle,
    sttFile,
    sttLanguage,
    sttTemp,
    sttFormat,
    refImage,
    maskImage,
  };
  const requestBody = buildPlaygroundBody(fields);
  const apiEndpointUrl = `${localOrigin}${defaults.path}`;
  // Preview never embeds the live key (always YOUR_KEY); the live key only
  // travels in the fetch Authorization header at run time.
  const curlSnippet = buildPlaygroundCurl({
    method: "POST",
    url: apiEndpointUrl,
    pinnedConnectionId: connectionId,
    body: requestBody,
    isBinary: kind === "image" || kind === "tts",
    binaryFilename: kind === "image" ? "image.png" : "speech.mp3",
    ...(kind === "stt" ? { form: sttFormFields({ ...fields, sttFile }) } : {}),
  });

  const handleRun = async () => {
    if (!model) return;
    if (kind === "stt" && !sttFile) {
      setError("Please select an audio file to transcribe");
      return;
    }
    setRunning(true);
    setError("");
    setResult(null);
    clearTrackedUrls();
    const start = Date.now();
    try {
      let res;
      if (kind === "stt") {
        res = await fetch(`/api${defaults.path}`, {
          method: "POST",
          headers: playgroundHeaders(apiKey, connectionId, false),
          body: buildSttFormData(fields),
        });
      } else {
        res = await fetch(`/api${defaults.path}`, {
          method: "POST",
          headers: playgroundHeaders(apiKey, connectionId, true),
          body: JSON.stringify(requestBody),
        });
      }
      setLatency(Date.now() - start);
      const ctype = res.headers.get("content-type") || "";

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error?.message || data?.error || `HTTP ${res.status}`);
        return;
      }

      if (ctype.startsWith("image/")) {
        const blob = await res.blob();
        setTrackedImageUrl(URL.createObjectURL(blob));
        setResult({ type: "binary", size: blob.size });
      } else if (ctype.startsWith("audio/") || ctype === "application/octet-stream") {
        const blob = await res.blob();
        setTrackedAudioUrl(URL.createObjectURL(blob));
        setResult({ type: "binary", size: blob.size });
      } else {
        const data = await res.json();
        setResult(data);
        const previews = playgroundPreviews(data);
        if (previews.imageUrl) setTrackedImageUrl(previews.imageUrl);
        if (previews.audioUrl) setTrackedAudioUrl(previews.audioUrl);
      }
    } catch (e) {
      setError(e.message || "Network error");
    } finally {
      setRunning(false);
    }
  };

  const connectionOptions = [
    { value: "", label: "Auto (by priority)" },
    ...providerConnections.map((c) => ({
      value: c.id,
      label: c.name || c.email || c.id.slice(0, 8),
    })),
  ];

  return (
    <Card
      as="aside"
      aria-label={`${kindConfig?.label || "Media"} playground`}
      padding="md"
      className={`flex flex-col gap-4 shadow-card ${className}`}
    >
      {/* Header with Segmented toggle: Form vs cURL */}
      <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
        <h2 className="font-display text-xl font-bold tracking-tight text-text">Try it</h2>
        <SegmentedControl
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "form", label: "Form" },
            { value: "curl", label: "cURL" },
          ]}
          aria-label="Playground mode"
        />
      </div>

      {mode === "curl" ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className={eyebrowClass}>Request cURL</span>
            <Button
              size="sm"
              variant="ghost"
              icon={copiedCurl ? "check" : errorCurl ? "error" : "content_copy"}
              onClick={() => copyCurl(curlSnippet)}
            >
              {copiedCurl ? "Copied" : errorCurl ? "Couldn't copy" : "Copy"}
            </Button>
            <CopyStatus copied={copiedCurl} error={errorCurl} />
          </div>
          <pre className={codeBlockClass} dir="ltr">
            {curlSnippet}
          </pre>
        </div>
      ) : (
        <div className="flex flex-col gap-3.5">
          {/* Model and Connection selects: stacked full width so the model
              optgroup labels (provider) and full model ids stay readable
              in the narrow aside (YAN-402). */}
          <div className="flex flex-col gap-3">
            <Select
              label="Model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              options={availableModels}
              placeholder="Select a model"
            />
            <Select
              label="Connection"
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
              options={connectionOptions}
            />
          </div>

          {/* Primary Prompt / Input */}
          <Field label={defaults.inputLabel}>
            {({ inputId, describedBy }) => (
              <textarea
                id={inputId}
                rows={kind === "webFetch" ? 1 : 2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                aria-describedby={describedBy}
                className={controlClass}
              />
            )}
          </Field>

          {/* Kind-specific options (ponytail: per-kind useState fields; useReducer when field count grows) */}
          <PlaygroundKindFields
            kind={kind}
            imageSize={imageSize}
            setImageSize={setImageSize}
            refImage={refImage}
            setRefImage={setRefImage}
            maskImage={maskImage}
            setMaskImage={setMaskImage}
            dimensions={dimensions}
            setDimensions={setDimensions}
            ttsVoice={ttsVoice}
            setTtsVoice={setTtsVoice}
            ttsLanguage={ttsLanguage}
            setTtsLanguage={setTtsLanguage}
            ttsStyle={ttsStyle}
            setTtsStyle={setTtsStyle}
            sttFile={sttFile}
            setSttFile={setSttFile}
            sttLanguage={sttLanguage}
            setSttLanguage={setSttLanguage}
            sttTemp={sttTemp}
            setSttTemp={setSttTemp}
            sttFormat={sttFormat}
            setSttFormat={setSttFormat}
          />

          {/* Action button (ponytail: per-kind useState fields; useReducer when field count grows) */}
          <Button
            variant="primary"
            size="md"
            loading={running}
            disabled={running || !model}
            icon="play_arrow"
            onClick={handleRun}
            className="w-full"
          >
            {running ? "Running..." : "Run"}
          </Button>

          {error && <Callout variant="err">{error}</Callout>}

          {/* Result view reads live URLs from the ref-backed registry */}
          <PlaygroundResult
            imageUrl={objectUrlsRef.current.image}
            audioUrl={objectUrlsRef.current.audio}
            imageAlt={`Generated output for ${input}`}
            result={result}
            latency={latency}
            copiedRes={copiedRes}
            errorRes={errorRes}
            onCopyResult={() => copyRes(JSON.stringify(result, null, 2))}
            running={running}
          />
        </div>
      )}
    </Card>
  );
}

MediaPlayground.propTypes = {
  kind: PropTypes.string.isRequired,
  connections: PropTypes.array,
  className: PropTypes.string,
};
