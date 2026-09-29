"use client";

import PropTypes from "prop-types";
import { Button, Callout } from "@/shared/components";
import CopyStatus from "@/shared/components/CopyStatus";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { codeBlockClass, eyebrowClass, LatencyBadge } from "./exampleShared";
import { resultImageSrc } from "./genericExampleLogic";

/**
 * Generic media example result view (YAN-402): streaming progress, partial
 * preview, response JSON with copy, and the image preview/download.
 * Pure presentation — state lives in `useGenericExample`.
 */
export function GenericExampleResult({
  kind,
  running,
  progress,
  useStreaming,
  partialImage,
  result,
  binaryImageUrl,
  resultJson,
  defaultResponse,
  error,
}) {
  const { copied: copiedRes, error: errorRes, copy: copyRes } = useCopyToClipboard();
  const imageSrc = resultImageSrc(binaryImageUrl, result);

  return (
    <>
      {/* Streaming progress */}
      {(running || progress) && useStreaming && (
        <div
          className="flex flex-col gap-2 rounded-xl border border-line bg-raised px-4 py-3 sm:flex-row sm:items-center sm:gap-3"
          role="status"
        >
          <span
            className={`material-symbols-outlined text-[16px] text-coral-ink ${running ? "animate-spin" : ""}`}
            aria-hidden="true"
          >
            {running ? "progress_activity" : "check_circle"}
          </span>
          <span className="text-xs text-muted">
            {progress?.stage || "starting"}
            {!running && progress?.bytesReceived
              ? ` · ${(progress.bytesReceived / 1024).toFixed(1)} KB`
              : ""}
          </span>
        </div>
      )}

      {/* Partial image preview (codex stream) */}
      {partialImage?.b64_json && !result && (
        <div>
          <span className={eyebrowClass}>Partial preview</span>
          <img
            src={`data:image/png;base64,${partialImage.b64_json}`}
            alt="Partial"
            className="mt-1.5 max-w-full rounded-xl border border-line opacity-80"
            loading="lazy"
            decoding="async"
          />
        </div>
      )}

      {/* Error */}
      {error && (
        <Callout variant="err" title="Request failed">
          {error}
        </Callout>
      )}

      {/* Response */}
      <div>
        <div className="mb-1.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className={eyebrowClass}>
            Response <LatencyBadge ms={result?.latencyMs} />
          </span>
          {result && (
            <Button
              size="sm"
              variant="ghost"
              icon={copiedRes ? "check" : errorRes ? "error" : "content_copy"}
              onClick={() => copyRes(resultJson)}
            >
              {copiedRes ? "Copied" : errorRes ? "Couldn't copy" : "Copy"}
            </Button>
          )}
          <CopyStatus copied={copiedRes} error={errorRes} />
        </div>
        <pre className={`${codeBlockClass} opacity-80`} dir="ltr">
          {result ? resultJson : (defaultResponse ?? "")}
        </pre>
        {kind === "image" && (binaryImageUrl || result?.data?.data?.[0]) && (
          <div className="mt-2">
            <div className="mb-1.5 flex items-center justify-end">
              <a
                href={imageSrc}
                download="image.png"
                className="inline-flex min-h-10 items-center gap-1 rounded-lg text-xs text-muted transition-colors hover:text-text"
              >
                <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                  download
                </span>
                Download
              </a>
            </div>
            <img
              src={imageSrc}
              alt="Generated"
              className="max-w-full rounded-xl border border-line"
              loading="lazy"
              decoding="async"
            />
          </div>
        )}
      </div>
    </>
  );
}

GenericExampleResult.propTypes = {
  kind: PropTypes.string.isRequired,
  running: PropTypes.bool,
  progress: PropTypes.object,
  useStreaming: PropTypes.bool,
  partialImage: PropTypes.object,
  result: PropTypes.object,
  binaryImageUrl: PropTypes.string,
  resultJson: PropTypes.string,
  defaultResponse: PropTypes.string,
  error: PropTypes.string,
};
