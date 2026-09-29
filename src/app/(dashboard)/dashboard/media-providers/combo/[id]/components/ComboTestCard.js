"use client";

import PropTypes from "prop-types";
import { Button, Card } from "@/shared/components";

/** cURL preview plus the kind-specific probe result (image, audio or JSON). */
export default function ComboTestCard({
  curlExample,
  testing,
  testResult,
  testError,
  canRun,
  onRun,
}) {
  return (
    <Card>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold">Test example</h2>
        <Button
          size="sm"
          icon="play_arrow"
          onClick={onRun}
          loading={testing}
          disabled={!testing && !canRun}
        >
          Run test
        </Button>
      </div>
      {curlExample && (
        <pre
          dir="ltr"
          className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-raised p-3 font-mono text-xs"
        >
          {curlExample}
        </pre>
      )}
      <div aria-live="polite" className="mt-3 flex flex-col gap-3">
        {testError && (
          <p role="alert" className="break-words text-xs text-err">
            {testError}
          </p>
        )}
        {testing && <p className="text-xs text-muted">Testing</p>}
        {testResult && (
          <>
            {testResult.latencyMs != null && (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted">
                <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                  bolt
                </span>
                {testResult.latencyMs}ms
              </span>
            )}
            {testResult.imageUrl && (
              <div>
                <div className="mb-1.5 flex items-center justify-end">
                  <a
                    href={testResult.imageUrl}
                    download="image.png"
                    className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-coral-ink"
                  >
                    <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                      download
                    </span>
                    Download
                  </a>
                </div>
                {/* biome-ignore lint/performance/noImgElement: generated-image preview from object/blob URLs */}
                <img
                  src={testResult.imageUrl}
                  alt="Generated"
                  className="max-w-full rounded-lg border border-line"
                  loading="lazy"
                  decoding="async"
                />
              </div>
            )}
            {testResult.audioUrl && (
              <div>
                <div className="mb-1.5 flex items-center justify-end">
                  <a
                    href={testResult.audioUrl}
                    download="speech.mp3"
                    className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-coral-ink"
                  >
                    <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                      download
                    </span>
                    Download
                  </a>
                </div>
                {/* biome-ignore lint/a11y/useMediaCaption: generated speech playback has no captions */}
                <audio controls src={testResult.audioUrl} className="w-full" />
              </div>
            )}
            {testResult.json && (
              <pre
                dir="ltr"
                className="max-h-[300px] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-raised p-3 font-mono text-xs"
              >
                {testResult.json}
              </pre>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

ComboTestCard.propTypes = {
  curlExample: PropTypes.string.isRequired,
  testing: PropTypes.bool.isRequired,
  testResult: PropTypes.shape({
    json: PropTypes.string,
    imageUrl: PropTypes.string,
    audioUrl: PropTypes.string,
    latencyMs: PropTypes.number,
  }),
  testError: PropTypes.string,
  canRun: PropTypes.bool.isRequired,
  onRun: PropTypes.func.isRequired,
};
