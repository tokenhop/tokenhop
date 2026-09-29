"use client";

import PropTypes from "prop-types";
import { codeBlockClass, eyebrowClass, LatencyBadge } from "./exampleShared";

export const DEFAULT_TTS_RESPONSE_EXAMPLE = `// Audio will appear here after running.
// Example JSON response (response_format=json):
{
  "format": "mp3",
  "audio": "//NExAANaAIIAUAAANNNNNNNN..." // base64 encoded MP3
}`;

/**
 * TTS example result view (YAN-402): audio player + download + JSON excerpt,
 * or the default example before the first run.
 */
export function TtsExampleResult({ audioUrl, latency, jsonResponse }) {
  if (!audioUrl) {
    return (
      <div>
        <span className={eyebrowClass}>Response</span>
        <pre className={`mt-1.5 ${codeBlockClass} opacity-80`} dir="ltr">
          {DEFAULT_TTS_RESPONSE_EXAMPLE}
        </pre>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-1.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className={eyebrowClass}>
          Response <LatencyBadge ms={latency} />
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
                audio: jsonResponse.audio ? `${jsonResponse.audio.substring(0, 100)}...` : "",
              },
              null,
              2,
            )}
          </pre>
        </div>
      )}
    </div>
  );
}

TtsExampleResult.propTypes = {
  audioUrl: PropTypes.string,
  latency: PropTypes.number,
  jsonResponse: PropTypes.object,
};
