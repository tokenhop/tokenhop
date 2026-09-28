"use client";

import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { Button, Callout, Card, IconButton, Modal } from "@/shared/components";
import { AI_PROVIDERS, getProviderAlias } from "@/shared/constants/providers";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import CopyStatus from "@/shared/components/CopyStatus";
import { LoadingState } from "@/shared/components/StateViews";
import { createObjectUrlRegistry } from "@/shared/constants/playgroundUrls";
import { TTS_PROVIDER_CONFIG } from "@/shared/constants/ttsProviders";
import { getTtsVoicesForModel } from "open-sse/config/ttsModels.js";
import { GOOGLE_TTS_LANGUAGES } from "open-sse/config/googleTtsLanguages.js";
import {
  Row,
  controlClass,
  readonlyClass,
  codeBlockClass,
  eyebrowClass,
  tunnelToggleClass,
} from "./exampleShared";
import { maskPreviewApiKey, previewAuthHeader } from "@/shared/constants/previewAuth";

const DEFAULT_TTS_RESPONSE_EXAMPLE = `// Audio will appear here after running.
// Example JSON response (response_format=json):
{
  "format": "mp3",
  "audio": "//NExAANaAIIAUAAANNNNNNNN..." // base64 encoded MP3
}`;

export function TtsExampleCard({ providerId }) {
  const providerAlias = getProviderAlias(providerId);
  const config = TTS_PROVIDER_CONFIG[providerId] || TTS_PROVIDER_CONFIG["edge-tts"];

  // Voice state
  const [selectedVoice, setSelectedVoice] = useState(config.defaultVoiceId || "");
  const [voiceId, setVoiceId] = useState(config.defaultVoiceId || ""); // editable voice id (elevenlabs/config providers)
  // Voices shown below Voice row after language selected
  const [countryVoices, setCountryVoices] = useState([]);
  const [selectedLang, setSelectedLang] = useState("");
  const [selectedModel, setSelectedModel] = useState(() => {
    const cfgModels = AI_PROVIDERS[providerId]?.ttsConfig?.models;
    if (cfgModels?.length) return cfgModels[0].id;
    if (config.hasModelSelector && config.modelKey) {
      const models = getModelsByProviderId(config.modelKey);
      return models?.[0]?.id || "";
    }
    return "";
  });

  // Form state
  const [input, setInput] = useState("Hello, this is a text to speech test.");
  const [style, setStyle] = useState(""); // style/voice instructions (e.g. MiMo voicedesign)
  const [apiKey, setApiKey] = useState("");
  const [useTunnel, setUseTunnel] = useState(false);
  const [localEndpoint, setLocalEndpoint] = useState("");
  const [tunnelEndpoint, setTunnelEndpoint] = useState("");
  const [responseFormat, setResponseFormat] = useState("mp3"); // mp3 | json
  const [audioUrl, setAudioUrl] = useState("");
  const [jsonResponse, setJsonResponse] = useState(null); // Store JSON response
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [latency, setLatency] = useState(null);
  const { copied: copiedCurl, error: errorCurl, copy: copyCurl } = useCopyToClipboard();

  // Country picker modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [languages, setLanguages] = useState([]);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalSearch, setModalSearch] = useState("");
  const [modalError, setModalError] = useState("");
  const [byLang, setByLang] = useState({});
  // Language hint (e.g. Gemini/MiMo): guides the spoken language without affecting voice selection
  const [languageHint, setLanguageHint] = useState("");
  // Number of stored provider connections (shown when no dashboard API key)
  const [connectionCount, setConnectionCount] = useState(0);

  // Ref-tracked blob URL: the unmount cleanup revokes the live URL even
  // though React state is stale inside cleanup closures.
  const audioUrlRef = useRef({ image: "", audio: "" });
  const [audioUrls] = useState(() => createObjectUrlRegistry(audioUrlRef));

  // Revoke the live blob URL on unmount via the ref (state is stale here).
  // biome-ignore lint/correctness/useExhaustiveDependencies: cleanup on unmount only
  useEffect(() => audioUrls.revokeAll, []);

  useEffect(() => {
    setLocalEndpoint(window.location.origin);
    fetch("/api/keys")
      .then((r) => r.json())
      .then((d) => {
        setApiKey((d.keys || []).find((k) => k.isActive !== false)?.key || "");
      })
      .catch(() => {});
    fetch("/api/providers", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setConnectionCount(
          (d.connections || []).filter((c) => c.provider === providerId && c.isActive !== false)
            .length,
        );
      })
      .catch(() => {});
    fetch("/api/tunnel/status")
      .then((r) => r.json())
      .then((d) => {
        if (d.tunnel?.publicUrl) setTunnelEndpoint(d.tunnel.publicUrl);
      })
      .catch(() => {});

    // Pre-select default voice based on provider config
    if (config.voiceSource === "hardcoded") {
      const defaultModel =
        config.hasModelSelector && config.modelKey
          ? getModelsByProviderId(config.modelKey)?.[0]?.id || ""
          : "";
      // Use per-model voices if available, else flat list
      const voices =
        config.voicesPerModel && defaultModel
          ? getTtsVoicesForModel(providerId, defaultModel) || []
          : getModelsByProviderId(config.voiceKey || providerId).filter(
              (m) => getModelKind(m) === "tts",
            );
      if (voices.length) {
        if (config.hasBrowseButton) {
          // Google TTS: pre-select "en" (English) as default, show as single voice chip
          const defaultVoice = voices.find((v) => v.id === "en") || voices[0];
          setSelectedLang(defaultVoice.id);
          setSelectedVoice(defaultVoice.id);
          setCountryVoices([{ id: defaultVoice.id, name: defaultVoice.name }]);
        } else {
          // OpenAI/OpenRouter: set voice chips directly (no language picker)
          setCountryVoices(voices);
          setSelectedVoice(voices[0].id);
        }
      }
    }
    // api-language (edge-tts, local-device, elevenlabs): NO default load, wait for user to pick language
    // config (nvidia, hyperbolic, deepgram, huggingface, cartesia, playht, coqui, tortoise, inworld, qwen):
    // use ttsConfig.models for model selector; voice is empty by default (backend uses provider default)
  }, [providerId]);

  // Update voices when model changes (voicesPerModel providers)
  useEffect(() => {
    if (!config.voicesPerModel || !selectedModel) return;
    const voices = getTtsVoicesForModel(providerId, selectedModel) || [];
    setCountryVoices(voices);
    if (voices.length) {
      setSelectedVoice(voices[0].id);
    } else {
      // Model has no preset voices (voicedesign/voiceclone) — drop stale voice
      setSelectedVoice("");
    }
  }, [selectedModel]);

  // Open modal — load language list
  const openModal = async () => {
    setModalOpen(true);
    setModalSearch("");
    setModalError("");
    if (languages.length) return; // already loaded
    setModalLoading(true);
    try {
      if (config.voiceSource === "hardcoded") {
        // Build languages/byLang from static providerModels data
        const voiceKey = config.voiceKey || providerId;
        const voices = getModelsByProviderId(voiceKey).filter((m) => getModelKind(m) === "tts");
        const byLangMap = {};
        for (const v of voices) {
          if (!byLangMap[v.id])
            byLangMap[v.id] = { code: v.id, name: v.name, voices: [{ id: v.id, name: v.name }] };
        }
        setByLang(byLangMap);
        setLanguages(Object.values(byLangMap).sort((a, b) => a.name.localeCompare(b.name)));
      } else {
        // Use provider-specific apiEndpoint if available, else default to edge-tts voices API
        const url = config.apiEndpoint
          ? config.apiEndpoint
          : `/api/media-providers/tts/voices?provider=${providerId === "local-device" ? "local-device" : "edge-tts"}`;
        const r = await fetch(url);
        const d = await r.json();
        if (d.error) {
          setModalError(d.error);
          return;
        }
        setLanguages(d.languages || []);
        setByLang(d.byLang || {});
      }
    } catch (e) {
      setModalError(e.message);
    } finally {
      setModalLoading(false);
    }
  };

  // Click language → close modal → show voices below
  const handlePickLanguage = (lang) => {
    setModalOpen(false);
    setSelectedLang(lang.code);
    const voices = byLang[lang.code]?.voices || [];
    setCountryVoices(voices);
    // Auto-select first voice
    if (voices.length) {
      setSelectedVoice(voices[0].id);
      if (config.hasVoiceIdInput) setVoiceId(voices[0].id);
    }
  };

  const filteredLanguages = modalSearch
    ? languages.filter(
        (c) =>
          c.name.toLowerCase().includes(modalSearch.toLowerCase()) ||
          c.code.toLowerCase().includes(modalSearch.toLowerCase()),
      )
    : languages;

  const endpoint = useTunnel ? tunnelEndpoint : localEndpoint;
  // For ElevenLabs/config-driven: prefer manual voiceId (if any), else fall back to selectedVoice
  const activeVoiceId = config.hasVoiceIdInput ? voiceId || selectedVoice : selectedVoice;
  const modelFull = (() => {
    if (config.hasModelSelector && selectedModel && activeVoiceId)
      return `${providerAlias}/${selectedModel}/${activeVoiceId}`;
    if (config.hasModelSelector && selectedModel) return `${providerAlias}/${selectedModel}`;
    if (activeVoiceId) return `${providerAlias}/${activeVoiceId}`;
    return "";
  })();

  const ttsBody = (() => {
    const b = { model: modelFull, input };
    if (config.hasLanguageHint && languageHint) b.language = languageHint;
    if (config.hasStyleInput && style.trim()) b.style = style.trim();
    return b;
  })();
  // Preview-safe: rendered/copied cURL always shows Bearer YOUR_KEY.
  // The live key is only sent in the fetch Authorization header below.
  const curlSnippet = `curl -X POST ${endpoint}/v1/audio/speech${responseFormat === "json" ? "?response_format=json" : ""} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: ${previewAuthHeader(apiKey)}" \\
  -d '${JSON.stringify(ttsBody)}' \\
  ${responseFormat === "json" ? "" : "--output speech.mp3"}`;

  const handleRun = async () => {
    if (!input.trim() || !modelFull) return;
    setRunning(true);
    setError("");
    audioUrls.clear();
    setAudioUrl("");
    setJsonResponse(null);
    const start = Date.now();
    try {
      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const url = `/api/v1/audio/speech${responseFormat === "json" ? "?response_format=json" : ""}`;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...ttsBody, input: input.trim() }),
      });
      setLatency(Date.now() - start);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d?.error?.message || d?.error || `HTTP ${res.status}`);
        return;
      }

      if (responseFormat === "json") {
        const data = await res.json();
        setJsonResponse(data); // Store full JSON response
        const format = data.format || "mp3";
        const audioBlob = await fetch(`data:audio/${format};base64,${data.audio}`).then((r) =>
          r.blob(),
        );
        // Registry revokes the previous URL on replace and on unmount.
        const nextUrl = URL.createObjectURL(audioBlob);
        audioUrls.setAudio(nextUrl);
        setAudioUrl(nextUrl);
      } else {
        const blob = await res.blob();
        // Registry revokes the previous URL on replace and on unmount.
        const nextUrl = URL.createObjectURL(blob);
        audioUrls.setAudio(nextUrl);
        setAudioUrl(nextUrl);
      }
    } catch (e) {
      setError(e.message || "Network error");
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <Card
        title={`${providerAlias} example`}
        subtitle="Generate speech from text with a live TTS request."
        icon="labs"
      >
        <div className="flex flex-col gap-2.5">
          {/* Endpoint + API Key as read-only text */}
          <Row label="Endpoint">
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              <span className={readonlyClass} dir="ltr">
                {endpoint}/v1/audio/speech
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
          <Row label="API Key">
            <span className={readonlyClass} dir="ltr">
              {apiKey ? (
                maskPreviewApiKey(apiKey)
              ) : connectionCount > 0 ? (
                <span className="text-subtle italic">
                  Using stored key(s) · {connectionCount} connection{connectionCount > 1 ? "s" : ""}
                </span>
              ) : (
                <span className="text-subtle italic">No key configured</span>
              )}
            </span>
          </Row>

          {/* Model selector — prefer PROVIDER_MODELS[kind=tts], else providerModels via modelKey */}
          {config.hasModelSelector &&
            (config.modelKey ||
              getModelsByProviderId(providerId).some((m) => getModelKind(m) === "tts")) && (
              <Row label="Model">
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  aria-label="Model"
                  className={controlClass}
                >
                  {(() => {
                    const ttsModels = getModelsByProviderId(providerId).filter(
                      (m) => getModelKind(m) === "tts",
                    );
                    return (
                      ttsModels.length ? ttsModels : getModelsByProviderId(config.modelKey) || []
                    ).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name || m.id}
                      </option>
                    ));
                  })()}
                </select>
              </Row>
            )}

          {/* Language hint dropdown (Gemini, Xiaomi MiMo) — sends body.language to guide pronunciation */}
          {config.hasLanguageHint && (
            <Row label="Language">
              <select
                value={languageHint}
                onChange={(e) => setLanguageHint(e.target.value)}
                aria-label="Language"
                className={`${controlClass} font-mono`}
              >
                <option value="">Auto-detect</option>
                {(config.languageOptions || GOOGLE_TTS_LANGUAGES).map((l) =>
                  typeof l === "string" ? (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ) : (
                    <option key={l.id} value={l.name}>
                      {l.name}
                    </option>
                  ),
                )}
              </select>
            </Row>
          )}

          {/* Language row + Browse button (edge-tts, local-device, elevenlabs) */}
          {config.hasBrowseButton && (
            <Row label="Language">
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                <button
                  type="button"
                  onClick={openModal}
                  className={`${controlClass} min-w-0 flex-1 truncate text-start font-mono`}
                >
                  {selectedLang ? (
                    <span className="text-text">
                      {languages.find((l) => l.code === selectedLang)?.name || selectedLang}
                    </span>
                  ) : (
                    <span className="text-subtle">No language selected</span>
                  )}
                </button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="language"
                  onClick={openModal}
                  className="w-full sm:w-auto"
                >
                  Select language
                </Button>
              </div>
            </Row>
          )}

          {/* Voice chips — shown after language picked (edge-tts, local-device) or always (OpenAI/ElevenLabs/MiMo) */}
          {countryVoices.length > 0 && (
            <Row label="Voice">
              <div className="flex flex-wrap gap-1.5">
                {countryVoices.map((v) => {
                  const selected = selectedVoice === v.id;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        setSelectedVoice(v.id);
                        if (config.hasVoiceIdInput) setVoiceId(v.id);
                      }}
                      className={`min-h-10 rounded-pill border px-2.5 py-1 text-xs transition-colors ${
                        selected
                          ? "border-coral bg-coral-bg font-medium text-coral-ink"
                          : "border-line text-muted hover:border-coral/40 hover:text-text"
                      }`}
                    >
                      {v.name}
                      {v.language ? ` · ${v.language}` : ""}
                      {v.gender ? ` · ${v.gender[0].toUpperCase()}` : ""}
                      {v.free_users_allowed === true && (
                        <span className="ms-1.5 rounded border border-ok/20 bg-ok-bg px-1 py-0.5 text-[9px] font-semibold text-ok">
                          Free
                        </span>
                      )}
                      {v.free_users_allowed === false && (
                        <span className="ms-1.5 rounded border border-warn/20 bg-warn-bg px-1 py-0.5 text-[9px] font-semibold text-warn">
                          Paid
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </Row>
          )}

          {/* Voice ID input (ElevenLabs) — manual entry or auto-fill from chip */}
          {config.hasVoiceIdInput && (
            <Row label="Voice ID">
              <div className="flex flex-col gap-1">
                <div className="relative">
                  <input
                    value={voiceId}
                    onChange={(e) => {
                      setVoiceId(e.target.value);
                      setSelectedVoice(e.target.value);
                    }}
                    placeholder="e.g. CwhRBWXzGAHq8TQ4Fs17"
                    aria-label="Voice ID"
                    autoComplete="off"
                    className={`${controlClass} pe-11 font-mono`}
                    dir="ltr"
                  />
                  {voiceId && (
                    <IconButton
                      icon="close"
                      label="Clear voice"
                      onClick={() => {
                        setVoiceId("");
                        setSelectedVoice("");
                      }}
                      className="absolute end-1 top-1/2 size-9 -translate-y-1/2 border-0 bg-transparent"
                    />
                  )}
                </div>
              </div>
            </Row>
          )}

          {/* Google TTS: Language dropdown */}
          {config.hasLanguageDropdown && (
            <Row label="Language">
              <select
                value={selectedVoice}
                onChange={(e) => {
                  const m = getModelsByProviderId(providerId)
                    .filter((m) => getModelKind(m) === "tts")
                    .find((m) => m.id === e.target.value);
                  setSelectedVoice(e.target.value);
                }}
                aria-label="Language"
                className={`${controlClass} font-mono`}
              >
                {getModelsByProviderId(providerId)
                  .filter((m) => getModelKind(m) === "tts")
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name || m.id}
                    </option>
                  ))}
              </select>
            </Row>
          )}

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
                  label="Clear text"
                  onClick={() => setInput("")}
                  className="absolute end-1 top-1/2 size-9 -translate-y-1/2 border-0 bg-transparent"
                />
              )}
            </div>
          </Row>

          {/* Style / voice instructions (Xiaomi MiMo) */}
          {config.hasStyleInput && (
            <Row label="Style">
              <div className="relative">
                <textarea
                  value={style}
                  onChange={(e) => setStyle(e.target.value)}
                  placeholder="e.g. a warm, gentle voice, speaking slowly with a British accent"
                  aria-label="Style"
                  rows={2}
                  className={`${controlClass} h-auto resize-none py-2.5 pe-11 leading-relaxed`}
                />
                {style && (
                  <IconButton
                    icon="close"
                    label="Clear style"
                    onClick={() => setStyle("")}
                    className="absolute end-1 top-1/2 size-9 -translate-y-1/2 border-0 bg-transparent"
                  />
                )}
              </div>
            </Row>
          )}

          {/* Output Format */}
          <Row label="Output Format">
            <select
              value={responseFormat}
              onChange={(e) => setResponseFormat(e.target.value)}
              aria-label="Output Format"
              className={controlClass}
            >
              <option value="mp3">MP3 (Binary)</option>
              <option value="json">JSON (Base64)</option>
            </select>
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
                  {running ? "Generating..." : "Run"}
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

          {/* Audio player */}
          {audioUrl ? (
            <div>
              <div className="mb-1.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className={eyebrowClass}>
                  Response{" "}
                  {latency && (
                    <span className="font-mono text-xs font-normal normal-case text-muted">
                      ⚡ {latency}ms
                    </span>
                  )}
                </span>
                <a
                  href={audioUrl}
                  download="speech.mp3"
                  className="inline-flex min-h-10 items-center gap-1 rounded-lg text-xs text-muted transition-colors hover:text-text"
                >
                  <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                    download
                  </span>
                  Download
                </a>
              </div>
              <audio
                controls
                src={audioUrl}
                className="w-full rounded-xl border border-line bg-raised p-2"
              />

              {/* JSON Response (if format is json) */}
              {jsonResponse && (
                <div className="mt-3">
                  <div className="mb-1.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <span className={eyebrowClass}>JSON Response</span>
                  </div>
                  <pre className={codeBlockClass} dir="ltr">
                    {JSON.stringify(
                      {
                        format: jsonResponse.format,
                        audio: jsonResponse.audio
                          ? `${jsonResponse.audio.substring(0, 100)}...`
                          : "",
                      },
                      null,
                      2,
                    )}
                  </pre>
                </div>
              )}
            </div>
          ) : (
            <div>
              <span className={eyebrowClass}>Response</span>
              <pre className={`mt-1.5 ${codeBlockClass} opacity-80`} dir="ltr">
                {DEFAULT_TTS_RESPONSE_EXAMPLE}
              </pre>
            </div>
          )}
        </div>
      </Card>

      {/* Country Picker Modal */}
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Select Language">
        <div className="flex flex-col">
          {/* Search */}
          <div className="border-b border-line px-4 py-2.5">
            <input
              aria-label="Search languages"
              value={modalSearch}
              onChange={(e) => setModalSearch(e.target.value)}
              placeholder="Search language..."
              className={controlClass}
            />
          </div>

          {/* Language list */}
          <div className="overflow-y-auto flex-1 p-2">
            {modalError && (
              <p className="px-2 py-1 text-xs text-err" role="alert">
                {modalError}
              </p>
            )}
            {modalLoading ? (
              <LoadingState lines={4} label="Loading languages" className="px-2 py-3" />
            ) : (
              <div className="flex flex-col gap-0.5">
                {filteredLanguages.map((c) => (
                  <button
                    type="button"
                    key={c.code}
                    onClick={() => handlePickLanguage(c)}
                    className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-start transition-colors hover:bg-raised focus-visible:shadow-focus ${
                      selectedLang === c.code ? "bg-coral-bg text-coral-ink" : "text-text"
                    }`}
                  >
                    <span className="text-sm">{c.name}</span>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-muted">{c.voices.length} voices</span>
                      {selectedLang === c.code && (
                        <span
                          className="material-symbols-outlined text-[16px] text-coral-ink"
                          aria-hidden="true"
                        >
                          check
                        </span>
                      )}
                    </div>
                  </button>
                ))}
                {filteredLanguages.length === 0 && (
                  <p className="text-xs text-muted px-2 py-3">No languages found.</p>
                )}
              </div>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}

TtsExampleCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
