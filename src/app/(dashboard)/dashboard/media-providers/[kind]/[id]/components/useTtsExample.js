"use client";

import { useState, useEffect, useRef } from "react";
import { AI_PROVIDERS, getProviderAlias } from "@/shared/constants/providers";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { createObjectUrlRegistry } from "@/shared/constants/playgroundUrls";
import { TTS_PROVIDER_CONFIG } from "@/shared/constants/ttsProviders";
import { getTtsVoicesForModel } from "open-sse/config/ttsModels.js";
import {
  initialTtsModel,
  defaultTtsSelection,
  buildHardcodedLanguages,
  buildTtsModelFull,
  buildTtsBody,
  buildTtsCurl,
} from "./ttsExampleLogic";

/**
 * State, effects and handlers for `TtsExampleCard` (YAN-402). Keeps the
 * fetch/blob/latency behaviour of the original card; the component composes
 * this hook with `TtsExampleForm`, `TtsExampleResult` and `TtsLanguageModal`.
 */
export function useTtsExample(providerId) {
  const providerAlias = getProviderAlias(providerId);
  const config = TTS_PROVIDER_CONFIG[providerId] || TTS_PROVIDER_CONFIG["edge-tts"];

  // Voice state
  const [selectedVoice, setSelectedVoice] = useState(config.defaultVoiceId || "");
  const [voiceId, setVoiceId] = useState(config.defaultVoiceId || ""); // editable voice id (elevenlabs/config providers)
  // Voices shown below Voice row after language selected
  const [countryVoices, setCountryVoices] = useState([]);
  const [selectedLang, setSelectedLang] = useState("");
  const [selectedModel, setSelectedModel] = useState(() =>
    initialTtsModel({
      cfgModels: AI_PROVIDERS[providerId]?.ttsConfig?.models || [],
      modelKeyModels:
        config.hasModelSelector && config.modelKey
          ? getModelsByProviderId(config.modelKey) || []
          : [],
      config,
    }),
  );

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
      const selection = defaultTtsSelection({
        config,
        defaultModel,
        perModelVoices:
          config.voicesPerModel && defaultModel
            ? getTtsVoicesForModel(providerId, defaultModel) || []
            : [],
        flatVoices: getModelsByProviderId(config.voiceKey || providerId).filter(
          (m) => getModelKind(m) === "tts",
        ),
      });
      if (selection) {
        setSelectedLang(selection.lang);
        setSelectedVoice(selection.voiceId);
        setCountryVoices(selection.voices);
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
        const built = buildHardcodedLanguages(voices);
        setByLang(built.byLang);
        setLanguages(built.languages);
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

  const endpoint = useTunnel ? tunnelEndpoint : localEndpoint;
  // For ElevenLabs/config-driven: prefer manual voiceId (if any), else fall back to selectedVoice
  const activeVoiceId = config.hasVoiceIdInput ? voiceId || selectedVoice : selectedVoice;
  const modelFull = buildTtsModelFull({
    alias: providerAlias,
    config,
    model: selectedModel,
    voiceId: activeVoiceId,
  });

  const ttsBody = buildTtsBody({ modelFull, input, config, languageHint, style });
  const curlSnippet = buildTtsCurl({ endpoint, responseFormat, apiKey, body: ttsBody });

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

  return {
    providerAlias,
    config,
    selectedVoice,
    setSelectedVoice,
    voiceId,
    setVoiceId,
    countryVoices,
    selectedLang,
    selectedModel,
    setSelectedModel,
    input,
    setInput,
    style,
    setStyle,
    apiKey,
    useTunnel,
    setUseTunnel,
    endpoint,
    tunnelEndpoint,
    responseFormat,
    setResponseFormat,
    audioUrl,
    jsonResponse,
    running,
    error,
    latency,
    modalOpen,
    setModalOpen,
    languages,
    modalLoading,
    modalSearch,
    setModalSearch,
    modalError,
    languageHint,
    setLanguageHint,
    connectionCount,
    openModal,
    handlePickLanguage,
    modelFull,
    curlSnippet,
    handleRun,
  };
}
