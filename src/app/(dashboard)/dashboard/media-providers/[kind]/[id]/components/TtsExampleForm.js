"use client";

import PropTypes from "prop-types";
import { IconButton } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { maskPreviewApiKey } from "@/shared/constants/previewAuth";
import {
  Row,
  controlClass,
  readonlyClass,
  tunnelToggleClass,
  ExampleRequestBlock,
} from "./exampleShared";
import { TtsVoiceFields } from "./TtsVoiceFields";

/**
 * TTS example form rows (YAN-402): endpoint/key, voice/language fields
 * (`TtsVoiceFields`), input, style and output format. Pure presentation —
 * state lives in `useTtsExample`.
 */
export function TtsExampleForm({
  providerId,
  config,
  apiKey,
  connectionCount,
  endpoint,
  tunnelEndpoint,
  useTunnel,
  onToggleTunnel,
  selectedModel,
  onSelectModel,
  languageHint,
  onSelectLanguageHint,
  selectedLang,
  languages,
  onOpenLanguageModal,
  countryVoices,
  selectedVoice,
  onSelectVoice,
  voiceId,
  onChangeVoiceId,
  input,
  onInputChange,
  style,
  onStyleChange,
  responseFormat,
  onResponseFormatChange,
  curlSnippet,
  running,
  canRun,
  onRun,
}) {
  const { copied: copiedCurl, error: errorCurl, copy: copyCurl } = useCopyToClipboard();

  return (
    <>
      {/* Endpoint + API Key as read-only text */}
      <Row label="Endpoint">
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          <span className={readonlyClass} dir="ltr">
            {endpoint}/v1/audio/speech
          </span>
          {tunnelEndpoint && (
            <button
              type="button"
              onClick={onToggleTunnel}
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

      <TtsVoiceFields
        providerId={providerId}
        config={config}
        selectedModel={selectedModel}
        onSelectModel={onSelectModel}
        languageHint={languageHint}
        onSelectLanguageHint={onSelectLanguageHint}
        selectedLang={selectedLang}
        languages={languages}
        onOpenLanguageModal={onOpenLanguageModal}
        countryVoices={countryVoices}
        selectedVoice={selectedVoice}
        onSelectVoice={onSelectVoice}
        voiceId={voiceId}
        onChangeVoiceId={onChangeVoiceId}
      />

      {/* Input */}
      <Row label="Input">
        <div className="relative">
          <input
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            aria-label="Input"
            className={`${controlClass} pe-11`}
          />
          {input && (
            <IconButton
              icon="close"
              label="Clear text"
              onClick={() => onInputChange("")}
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
              onChange={(e) => onStyleChange(e.target.value)}
              placeholder="e.g. a warm, gentle voice, speaking slowly with a British accent"
              aria-label="Style"
              rows={2}
              className={`${controlClass} h-auto resize-none py-2.5 pe-11 leading-relaxed`}
            />
            {style && (
              <IconButton
                icon="close"
                label="Clear style"
                onClick={() => onStyleChange("")}
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
          onChange={(e) => onResponseFormatChange(e.target.value)}
          aria-label="Output Format"
          className={controlClass}
        >
          <option value="mp3">MP3 (Binary)</option>
          <option value="json">JSON (Base64)</option>
        </select>
      </Row>

      <ExampleRequestBlock
        curlSnippet={curlSnippet}
        running={running}
        runningLabel="Generating..."
        canRun={canRun}
        onRun={onRun}
        copied={copiedCurl}
        copyError={errorCurl}
        onCopy={() => copyCurl(curlSnippet)}
      />
    </>
  );
}

TtsExampleForm.propTypes = {
  providerId: PropTypes.string.isRequired,
  config: PropTypes.object.isRequired,
  apiKey: PropTypes.string,
  connectionCount: PropTypes.number,
  endpoint: PropTypes.string,
  tunnelEndpoint: PropTypes.string,
  useTunnel: PropTypes.bool,
  onToggleTunnel: PropTypes.func.isRequired,
  selectedModel: PropTypes.string,
  onSelectModel: PropTypes.func.isRequired,
  languageHint: PropTypes.string,
  onSelectLanguageHint: PropTypes.func.isRequired,
  selectedLang: PropTypes.string,
  languages: PropTypes.array,
  onOpenLanguageModal: PropTypes.func.isRequired,
  countryVoices: PropTypes.array,
  selectedVoice: PropTypes.string,
  onSelectVoice: PropTypes.func.isRequired,
  voiceId: PropTypes.string,
  onChangeVoiceId: PropTypes.func.isRequired,
  input: PropTypes.string,
  onInputChange: PropTypes.func.isRequired,
  style: PropTypes.string,
  onStyleChange: PropTypes.func.isRequired,
  responseFormat: PropTypes.string,
  onResponseFormatChange: PropTypes.func.isRequired,
  curlSnippet: PropTypes.string.isRequired,
  running: PropTypes.bool,
  canRun: PropTypes.bool,
  onRun: PropTypes.func.isRequired,
};
