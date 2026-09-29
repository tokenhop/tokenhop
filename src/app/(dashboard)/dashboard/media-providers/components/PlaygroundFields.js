"use client";

import PropTypes from "prop-types";
import { Button, Field, SegmentedControl } from "@/shared/components";
import { controlClass } from "../[kind]/[id]/components/exampleShared";
import CopyStatus from "@/shared/components/CopyStatus";

/**
 * Kind-specific playground inputs (YAN-305): image size/ref/mask, embedding
 * dimensions, TTS voice/language/style, STT file/language/temperature/format.
 */
export function PlaygroundKindFields({
  kind,
  imageSize,
  setImageSize,
  refImage,
  setRefImage,
  maskImage,
  setMaskImage,
  dimensions,
  setDimensions,
  ttsVoice,
  setTtsVoice,
  ttsLanguage,
  setTtsLanguage,
  ttsStyle,
  setTtsStyle,
  sttFile,
  setSttFile,
  sttLanguage,
  setSttLanguage,
  sttTemp,
  setSttTemp,
  sttFormat,
  setSttFormat,
}) {
  if (kind === "image") {
    return (
      <div className="flex flex-col gap-2.5">
        <span className="text-xs font-medium text-muted">Size</span>
        <SegmentedControl
          size="sm"
          value={imageSize}
          onChange={setImageSize}
          options={[
            { value: "1024x1024", label: "1024²" },
            { value: "1536x1024", label: "1536×1024" },
            { value: "1024x1536", label: "1024×1536" },
          ]}
          aria-label="Image size"
        />
        <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-2">
          <Field label="Reference image URL">
            {({ inputId }) => (
              <input
                id={inputId}
                value={refImage}
                onChange={(e) => setRefImage(e.target.value)}
                placeholder="Optional image URL"
                className={controlClass}
              />
            )}
          </Field>
          <Field label="Mask image URL">
            {({ inputId }) => (
              <input
                id={inputId}
                value={maskImage}
                onChange={(e) => setMaskImage(e.target.value)}
                placeholder="Optional mask URL"
                className={controlClass}
              />
            )}
          </Field>
        </div>
      </div>
    );
  }

  if (kind === "embedding") {
    return (
      <Field label="Dimensions">
        {({ inputId }) => (
          <input
            id={inputId}
            type="number"
            min="1"
            value={dimensions}
            onChange={(e) => setDimensions(e.target.value)}
            placeholder="e.g. 512, 1024 (leave empty for default)"
            className={controlClass}
          />
        )}
      </Field>
    );
  }

  if (kind === "tts") {
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Voice">
          {({ inputId }) => (
            <input
              id={inputId}
              value={ttsVoice}
              onChange={(e) => setTtsVoice(e.target.value)}
              placeholder="e.g. alloy, shimmer, echo"
              className={controlClass}
            />
          )}
        </Field>
        <Field label="Language hint">
          {({ inputId }) => (
            <input
              id={inputId}
              value={ttsLanguage}
              onChange={(e) => setTtsLanguage(e.target.value)}
              placeholder="e.g. en, vi, es"
              className={controlClass}
            />
          )}
        </Field>
        <div className="sm:col-span-2">
          <Field label="Style">
            {({ inputId }) => (
              <input
                id={inputId}
                value={ttsStyle}
                onChange={(e) => setTtsStyle(e.target.value)}
                placeholder="e.g. warm, slow, whisper"
                className={controlClass}
              />
            )}
          </Field>
        </div>
      </div>
    );
  }

  if (kind === "stt") {
    return (
      <div className="flex flex-col gap-2">
        <Field label="Audio file">
          {({ inputId }) => (
            <input
              id={inputId}
              type="file"
              accept="audio/*,video/mp4"
              onChange={(e) => setSttFile(e.target.files?.[0] || null)}
              className="w-full cursor-pointer text-xs text-muted file:me-2 file:cursor-pointer file:rounded-lg file:border file:border-line file:bg-raised file:px-2.5 file:py-1.5 file:text-xs file:font-semibold file:text-text hover:file:bg-line/40"
            />
          )}
        </Field>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="Language code">
            {({ inputId }) => (
              <input
                id={inputId}
                value={sttLanguage}
                onChange={(e) => setSttLanguage(e.target.value)}
                placeholder="e.g. en, ja, vi"
                className={controlClass}
              />
            )}
          </Field>
          <Field label="Temperature">
            {({ inputId }) => (
              <input
                id={inputId}
                type="number"
                step="0.1"
                min="0"
                max="1"
                value={sttTemp}
                onChange={(e) => setSttTemp(e.target.value)}
                placeholder="0 - 1"
                className={controlClass}
              />
            )}
          </Field>
          <Field label="Response format">
            {({ inputId }) => (
              <input
                id={inputId}
                value={sttFormat}
                onChange={(e) => setSttFormat(e.target.value)}
                placeholder="e.g. json, text, srt"
                className={controlClass}
              />
            )}
          </Field>
        </div>
        {sttFile && (
          <p className="font-mono text-xs text-muted" aria-live="polite">
            {sttFile.name} · {(sttFile.size / 1024).toFixed(1)} KB
          </p>
        )}
      </div>
    );
  }

  return null;
}

PlaygroundKindFields.propTypes = {
  kind: PropTypes.string.isRequired,
  imageSize: PropTypes.string,
  setImageSize: PropTypes.func,
  refImage: PropTypes.string,
  setRefImage: PropTypes.func,
  maskImage: PropTypes.string,
  setMaskImage: PropTypes.func,
  dimensions: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  setDimensions: PropTypes.func,
  ttsVoice: PropTypes.string,
  setTtsVoice: PropTypes.func,
  ttsLanguage: PropTypes.string,
  setTtsLanguage: PropTypes.func,
  ttsStyle: PropTypes.string,
  setTtsStyle: PropTypes.func,
  sttFile: PropTypes.object,
  setSttFile: PropTypes.func,
  sttLanguage: PropTypes.string,
  setSttLanguage: PropTypes.func,
  sttTemp: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  setSttTemp: PropTypes.func,
  sttFormat: PropTypes.string,
  setSttFormat: PropTypes.func,
};

/**
 * Playground result view: generated image preview with alt text, audio player,
 * or JSON response with latency + copy (YAN-305).
 */
export function PlaygroundResult({
  imageUrl,
  audioUrl,
  imageAlt,
  result,
  latency,
  copiedRes,
  errorRes,
  onCopyResult,
  running,
}) {
  return (
    <>
      {imageUrl && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
              Generated image
            </span>
            <Button size="sm" variant="ghost" icon="download" href={imageUrl} download="image.png">
              Download
            </Button>
          </div>
          <div className="relative overflow-hidden rounded-xl border border-line bg-raised">
            {/* biome-ignore lint/performance/noImgElement: generated-image preview from object/blob URLs */}
            <img
              src={imageUrl}
              alt={imageAlt}
              className="max-h-72 w-full object-contain"
              loading="lazy"
              decoding="async"
            />
          </div>
        </div>
      )}

      {audioUrl && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
              Generated audio
            </span>
            <Button size="sm" variant="ghost" icon="download" href={audioUrl} download="speech.mp3">
              Download
            </Button>
          </div>
          {/* biome-ignore lint/a11y/useMediaCaption: generated speech playback has no captions */}
          <audio controls src={audioUrl} className="w-full" />
        </div>
      )}

      {result && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
              Response {latency != null && `· ${latency}ms`}
            </span>
            {result.type !== "binary" && (
              <Button
                size="sm"
                variant="ghost"
                icon={copiedRes ? "check" : errorRes ? "error" : "content_copy"}
                onClick={onCopyResult}
              >
                {copiedRes ? "Copied" : errorRes ? "Couldn't copy" : "Copy"}
              </Button>
            )}
            <CopyStatus copied={copiedRes} error={errorRes} />
          </div>
          <pre
            className="m-0 max-h-48 overflow-x-auto whitespace-pre-wrap break-all rounded-xl border border-line bg-raised px-4 py-3 text-start font-mono text-xs leading-relaxed text-text"
            dir="ltr"
          >
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}

      {!result && !imageUrl && !audioUrl && !running && (
        <div
          role="img"
          aria-label="Result placeholder"
          className="flex min-h-[140px] items-center justify-center rounded-xl border border-dashed border-line bg-raised/30 p-6 text-center text-xs text-muted"
        >
          Result will appear here after running
        </div>
      )}
    </>
  );
}

PlaygroundResult.propTypes = {
  imageUrl: PropTypes.string,
  audioUrl: PropTypes.string,
  imageAlt: PropTypes.string,
  result: PropTypes.object,
  latency: PropTypes.number,
  copiedRes: PropTypes.string,
  errorRes: PropTypes.string,
  onCopyResult: PropTypes.func,
  running: PropTypes.bool,
};
