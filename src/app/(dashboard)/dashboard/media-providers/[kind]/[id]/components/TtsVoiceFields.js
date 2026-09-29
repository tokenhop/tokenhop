"use client";

import PropTypes from "prop-types";
import { Button, IconButton } from "@/shared/components";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { GOOGLE_TTS_LANGUAGES } from "open-sse/config/googleTtsLanguages.js";
import { Row, controlClass } from "./exampleShared";

/**
 * Voice/language-related rows of `TtsExampleForm` (YAN-402): model selector,
 * language hint, browse-language row, voice chips, voice ID input and the
 * Google language dropdown. Pure presentation — state lives in
 * `useTtsExample`.
 */
export function TtsVoiceFields({
  providerId,
  config,
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
}) {
  return (
    <>
      {/* Model selector — prefer PROVIDER_MODELS[kind=tts], else providerModels via modelKey */}
      {config.hasModelSelector &&
        (config.modelKey ||
          getModelsByProviderId(providerId).some((m) => getModelKind(m) === "tts")) && (
          <Row label="Model">
            <select
              value={selectedModel}
              onChange={(e) => onSelectModel(e.target.value)}
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
            onChange={(e) => onSelectLanguageHint(e.target.value)}
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
              onClick={onOpenLanguageModal}
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
              onClick={onOpenLanguageModal}
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
                  onClick={() => onSelectVoice(v.id)}
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
                onChange={(e) => onChangeVoiceId(e.target.value)}
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
                  onClick={() => onChangeVoiceId("")}
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
            onChange={(e) => onSelectVoice(e.target.value)}
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
    </>
  );
}

TtsVoiceFields.propTypes = {
  providerId: PropTypes.string.isRequired,
  config: PropTypes.object.isRequired,
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
};
