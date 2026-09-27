"use client";

import PropTypes from "prop-types";
import dynamic from "next/dynamic";
import { useTheme } from "@/shared/hooks/useTheme";
import {
  defineSignalMonacoThemes,
  SIGNAL_MONACO_DARK,
  SIGNAL_MONACO_LIGHT,
  safeFormatJson,
} from "@/shared/components/signalMonaco";
import { Card, Button, StatusPill, Skeleton } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import CopyStatus from "@/shared/components/CopyStatus";

const Editor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => <Skeleton className="h-[400px] w-full rounded-none border-0" />,
});

export const EDITOR_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 12,
  lineNumbers: "on",
  scrollBeyondLastLine: false,
  wordWrap: "on",
  automaticLayout: true,
};

/**
 * One collapsible translator step: header, Signal-themed Monaco editor,
 * and the per-step actions (Load/Format/Copy plus the pipeline action).
 */
export default function TranslatorStep({
  step,
  isExpanded,
  content,
  onToggle,
  onContentChange,
  onLoad,
  loadLoading,
  action,
}) {
  const { isDark } = useTheme();
  const { copy, copied, error } = useCopyToClipboard();

  const handleCopy = () => {
    if (!content) return;
    copy(content, `translator-step-${step.id}`);
  };

  const handleFormat = () => {
    const formatted = safeFormatJson(content);
    if (formatted !== null) onContentChange(step.id, formatted);
  };

  return (
    <Card padding="none">
      <div className="space-y-3 p-4">
        {/* Step header */}
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => onToggle(step.id)}
            aria-expanded={isExpanded}
            aria-controls={`translator-step-${step.id}-editor`}
            className="flex min-w-0 flex-1 items-center gap-2 text-start focus-visible:outline-none focus-visible:shadow-focus"
          >
            <span
              className={`material-symbols-outlined shrink-0 text-[20px] text-muted transition-transform ${
                isExpanded ? "rotate-180" : ""
              }`}
              aria-hidden="true"
            >
              expand_more
            </span>
            <span className="w-4 shrink-0 font-mono text-xs text-subtle">{step.id}</span>
            <span className="truncate text-sm font-semibold text-text">{step.label}</span>
            <span className="hidden shrink-0 font-mono text-xs text-subtle sm:inline">
              {step.file}
            </span>
            {content && (
              <StatusPill variant="neutral" size="sm" className="shrink-0">
                {content.length} chars
              </StatusPill>
            )}
          </button>
          {!isExpanded && (
            <div className="flex shrink-0 gap-1">
              <Button
                size="sm"
                variant="ghost"
                icon="folder_open"
                aria-label={`Load ${step.label}`}
                loading={loadLoading}
                onClick={onLoad}
              />
              {action}
            </div>
          )}
        </div>

        {/* Expanded content */}
        {isExpanded && (
          <div id={`translator-step-${step.id}-editor`}>
            <p className="mb-2 text-xs text-muted">{step.desc}</p>
            <div className="overflow-hidden rounded-xl border border-line">
              <Editor
                height="400px"
                defaultLanguage={step.lang === "text" ? "plaintext" : "json"}
                language={step.lang === "text" ? "plaintext" : "json"}
                value={content}
                onChange={(v) => onContentChange(step.id, v || "")}
                beforeMount={defineSignalMonacoThemes}
                theme={isDark ? SIGNAL_MONACO_DARK : SIGNAL_MONACO_LIGHT}
                options={EDITOR_OPTIONS}
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                icon="folder_open"
                loading={loadLoading}
                onClick={onLoad}
              >
                Load
              </Button>
              <Button size="sm" variant="secondary" icon="data_object" onClick={handleFormat}>
                Format
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon={
                  copied === `translator-step-${step.id}`
                    ? "check"
                    : error === `translator-step-${step.id}`
                      ? "error"
                      : "content_copy"
                }
                onClick={handleCopy}
              >
                {copied === `translator-step-${step.id}`
                  ? "Copied"
                  : error === `translator-step-${step.id}`
                    ? "Couldn't copy"
                    : "Copy"}
              </Button>
              <CopyStatus copied={copied} error={error} id={`translator-step-${step.id}`} />
              {action}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

TranslatorStep.propTypes = {
  step: PropTypes.shape({
    id: PropTypes.number.isRequired,
    label: PropTypes.string.isRequired,
    file: PropTypes.string.isRequired,
    lang: PropTypes.string.isRequired,
    desc: PropTypes.string.isRequired,
  }).isRequired,
  isExpanded: PropTypes.bool,
  content: PropTypes.string,
  onToggle: PropTypes.func.isRequired,
  onContentChange: PropTypes.func.isRequired,
  onLoad: PropTypes.func.isRequired,
  loadLoading: PropTypes.bool,
  action: PropTypes.node,
};
