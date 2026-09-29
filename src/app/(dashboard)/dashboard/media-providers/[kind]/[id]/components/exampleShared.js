"use client";

import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import CopyStatus from "@/shared/components/CopyStatus";

/**
 * Shared field chrome for the media example runner forms (YAN-305). A thin
 * label + control Row with the Signal body size/weight; the control chroming
 * (raised surface, line border, coral focus) lives in `controlClass`. Controls
 * keep their own `aria-label`, so the Row span is visual only.
 */
export function Row({ label, children }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
      <span aria-hidden="true" className="w-full shrink-0 text-xs font-medium text-muted sm:w-20">
        {label}
      </span>
      <div className="w-full min-w-0 flex-1">{children}</div>
    </div>
  );
}

Row.propTypes = {
  label: PropTypes.node.isRequired,
  children: PropTypes.node,
};

/**
 * Signal control chrome for the runner form fields: raised surface, line
 * border, radius 12, coral focus ring + glow (design-system §6). Mono when
 * the value is an identifier.
 */
export const controlClass =
  "h-11 w-full rounded-lg border border-line bg-raised px-3 text-sm text-text transition-colors duration-150 placeholder:text-subtle focus:border-coral focus:shadow-focus focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

/** Read-only mono value in control chrome (endpoint URL, masked key). */
export const readonlyClass =
  "flex h-11 w-full min-w-0 items-center truncate rounded-lg border border-line bg-raised px-3 font-mono text-sm text-text";

/** Code block for request snippets and responses (board `.code`). Always LTR. */
export const codeBlockClass =
  "m-0 overflow-x-auto rounded-xl border border-line bg-raised px-4 py-3 text-start font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-text";

/** Eyebrow label above request/response blocks. */
export const eyebrowClass = "text-xs font-semibold tracking-[0.08em] text-muted uppercase";

/** Tunnel toggle chip classes (pressed = coral selection). */
export function tunnelToggleClass(active) {
  return `flex min-h-10 shrink-0 items-center gap-1 rounded-lg border px-3 text-xs font-medium transition-colors ${
    active ? "border-coral/40 bg-coral-bg text-coral-ink" : "border-line text-muted hover:text-text"
  }`;
}

export const KIND_EXAMPLE_CONFIG = {
  webSearch: {
    inputLabel: "Query",
    inputPlaceholder: "What is the latest news about AI?",
    defaultInput: "What is the latest news about AI?",
    bodyKey: "query",
    defaultResponse: `{\n  "results": [\n    { "title": "...", "url": "...", "snippet": "..." }\n  ]\n}`,
    extraFields: [
      {
        key: "search_type",
        label: "Type",
        type: "select",
        default: "web",
        options: ["web", "news"],
      },
      { key: "max_results", label: "Max results", type: "number", default: 5, min: 1, max: 100 },
      { key: "country", label: "Country", type: "text", default: "" },
      { key: "language", label: "Language", type: "text", default: "" },
    ],
  },
  webFetch: {
    inputLabel: "URL",
    inputPlaceholder: "https://example.com",
    defaultInput: "https://example.com",
    bodyKey: "url",
    defaultResponse: `{\n  "content": "...",\n  "title": "...",\n  "url": "..."\n}`,
    extraFields: [
      {
        key: "format",
        label: "Format",
        type: "select",
        default: "markdown",
        options: ["markdown", "text", "html"],
      },
      { key: "max_characters", label: "Max chars", type: "number", default: 0, min: 0 },
    ],
  },
  image: {
    inputLabel: "Prompt",
    inputPlaceholder: "A cute cat wearing a hat",
    defaultInput: "A cute cat wearing a hat",
    bodyKey: "prompt",
    defaultResponse: `{\n  "data": [\n    { "url": "...", "b64_json": "..." }\n  ]\n}`,
    extraFields: [
      { key: "n", label: "n", type: "number", default: 1, min: 1, max: 4 },
      {
        key: "size",
        label: "Size",
        type: "select",
        default: "auto",
        options: ["auto", "1024x1024", "1024x1536", "1536x1024", "1024x1792", "1792x1024"],
      },
      {
        key: "quality",
        label: "Quality",
        type: "select",
        default: "auto",
        options: ["auto", "low", "medium", "high", "standard", "hd"],
      },
      {
        key: "background",
        label: "Background",
        type: "select",
        default: "auto",
        options: ["auto", "transparent", "opaque"],
      },
      {
        key: "style",
        label: "Style",
        type: "select",
        default: "",
        options: ["", "vivid", "natural"],
      },
      {
        key: "response_format",
        label: "Format",
        type: "select",
        default: "",
        options: ["", "url", "b64_json"],
      },
      {
        key: "image_detail",
        label: "Image Detail",
        type: "select",
        default: "high",
        options: ["auto", "low", "high", "original"],
      },
      {
        key: "output_format",
        label: "Codec",
        type: "select",
        default: "png",
        options: ["png", "jpeg", "webp"],
      },
    ],
  },
  imageToText: {
    inputLabel: "Image URL",
    inputPlaceholder: "https://example.com/image.png",
    defaultInput:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/1200px-Cat03.jpg",
    bodyKey: "url",
    extraBody: { prompt: "Describe this image in detail" },
    defaultResponse: `{\n  "text": "A cat sitting on a windowsill...",\n  "model": "..."\n}`,
  },
  video: {
    inputLabel: "Prompt",
    inputPlaceholder: "A serene lake at sunset",
    defaultInput: "A serene lake at sunset",
    bodyKey: "prompt",
    defaultResponse: `{\n  "data": [\n    { "url": "..." }\n  ]\n}`,
  },
  music: {
    inputLabel: "Prompt",
    inputPlaceholder: "A calm piano melody",
    defaultInput: "A calm piano melody",
    bodyKey: "prompt",
    defaultResponse: `{\n  "data": [\n    { "url": "...", "format": "mp3" }\n  ]\n}`,
  },
};

/**
 * Latency badge next to Response headings. Replaces the old emoji marker
 * with a Material Symbol (`bolt`, the same glyph used for token/usage
 * elsewhere).
 */
export function LatencyBadge({ ms }) {
  if (ms == null) return null;
  return (
    <span className="font-mono text-xs font-normal normal-case text-muted">
      <span className="material-symbols-outlined text-[12px] align-middle" aria-hidden="true">
        bolt
      </span>{" "}
      {ms}ms
    </span>
  );
}

LatencyBadge.propTypes = {
  ms: PropTypes.number,
};

/**
 * Shared Request block (copy + Run + cURL `<pre>`) used by the TTS, generic,
 * STT and embedding example cards (YAN-402). Markup mirrors the original
 * blocks so cards using it render identically.
 */
export function ExampleRequestBlock({
  curlSnippet,
  running,
  runningLabel,
  canRun,
  onRun,
  copied,
  copyError,
  onCopy,
}) {
  return (
    <div className="mt-1">
      <div className="mb-1.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className={eyebrowClass}>Request</span>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          <Button
            size="sm"
            variant="ghost"
            icon={copied ? "check" : copyError ? "error" : "content_copy"}
            onClick={onCopy}
          >
            {copied ? "Copied" : copyError ? "Couldn't copy" : "Copy"}
          </Button>
          <CopyStatus copied={copied} error={copyError} />
          <Button
            size="sm"
            variant="primary"
            icon="play_arrow"
            onClick={onRun}
            disabled={running || !canRun}
            loading={running}
          >
            {running ? runningLabel : "Run"}
          </Button>
        </div>
      </div>
      <pre className={codeBlockClass} dir="ltr">
        {curlSnippet}
      </pre>
    </div>
  );
}

ExampleRequestBlock.propTypes = {
  curlSnippet: PropTypes.string.isRequired,
  running: PropTypes.bool.isRequired,
  runningLabel: PropTypes.string.isRequired,
  canRun: PropTypes.bool.isRequired,
  onRun: PropTypes.func.isRequired,
  copied: PropTypes.string,
  copyError: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
};
