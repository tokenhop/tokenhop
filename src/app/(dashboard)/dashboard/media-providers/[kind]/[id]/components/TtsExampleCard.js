"use client";

import PropTypes from "prop-types";
import { Callout, Card } from "@/shared/components";
import { useTtsExample } from "./useTtsExample";
import { TtsExampleForm } from "./TtsExampleForm";
import { TtsExampleResult } from "./TtsExampleResult";
import { TtsLanguageModal } from "./TtsLanguageModal";

/**
 * Live TTS example for a media provider detail page (YAN-402). Composition
 * only: state lives in `useTtsExample`, rows in `TtsExampleForm`, the audio
 * result in `TtsExampleResult` and the language picker in `TtsLanguageModal`.
 */
export function TtsExampleCard({ providerId }) {
  const example = useTtsExample(providerId);
  const {
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
  } = example;

  return (
    <>
      <Card
        title={`${providerAlias} example`}
        subtitle="Generate speech from text with a live TTS request."
        icon="labs"
      >
        <div className="flex flex-col gap-2.5">
          <TtsExampleForm
            providerId={providerId}
            config={config}
            apiKey={apiKey}
            connectionCount={connectionCount}
            endpoint={endpoint}
            tunnelEndpoint={tunnelEndpoint}
            useTunnel={useTunnel}
            onToggleTunnel={() => setUseTunnel((v) => !v)}
            selectedModel={selectedModel}
            onSelectModel={setSelectedModel}
            languageHint={languageHint}
            onSelectLanguageHint={setLanguageHint}
            selectedLang={selectedLang}
            languages={languages}
            onOpenLanguageModal={openModal}
            countryVoices={countryVoices}
            selectedVoice={selectedVoice}
            onSelectVoice={(id) => {
              setSelectedVoice(id);
              if (config.hasVoiceIdInput) setVoiceId(id);
            }}
            voiceId={voiceId}
            onChangeVoiceId={(value) => {
              setVoiceId(value);
              setSelectedVoice(value);
            }}
            input={input}
            onInputChange={setInput}
            style={style}
            onStyleChange={setStyle}
            responseFormat={responseFormat}
            onResponseFormatChange={setResponseFormat}
            curlSnippet={curlSnippet}
            running={running}
            canRun={!!input.trim() && !!modelFull}
            onRun={handleRun}
          />

          {error && (
            <Callout variant="err" title="Request failed">
              {error}
            </Callout>
          )}

          <TtsExampleResult audioUrl={audioUrl} latency={latency} jsonResponse={jsonResponse} />
        </div>
      </Card>

      {/* Country Picker Modal */}
      <TtsLanguageModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        search={modalSearch}
        onSearchChange={setModalSearch}
        loading={modalLoading}
        error={modalError}
        languages={languages}
        selectedLang={selectedLang}
        onPickLanguage={handlePickLanguage}
      />
    </>
  );
}

TtsExampleCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
