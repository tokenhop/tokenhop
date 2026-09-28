"use client";

import PropTypes from "prop-types";
import { IconButton } from "@/shared/components";
import { cn } from "@/shared/utils/cn";

/**
 * Composer for basic chat: attachment chips, native textarea with an sr-only
 * label (keeps Enter-to-send / Shift+Enter-newline), attach + stop + lime send.
 */
export default function ChatComposer({
  draft,
  onDraftChange,
  onKeyDown,
  attachments,
  onRemoveAttachment,
  onAttachClick,
  onAttachFiles,
  fileInputRef,
  attachDisabled,
  activeModelName,
  isSending,
  onStop,
  canSend,
  onSend,
}) {
  return (
    <div className="shrink-0 pt-2">
      {attachments.length > 0 ? (
        <div className="mx-auto mb-3 flex w-full max-w-3xl flex-wrap gap-2 px-4">
          {attachments.map((attachment) => (
            <span
              key={attachment.id}
              className="flex min-h-10 items-center gap-2 rounded-full border border-line bg-raised px-3 py-1.5"
            >
              <span className="max-w-[12rem] truncate text-xs text-text">{attachment.name}</span>
              <IconButton
                icon="close"
                label={`Remove attachment ${attachment.name}`}
                onClick={() => onRemoveAttachment(attachment.id)}
                className="rounded-full border-transparent bg-transparent"
              />
            </span>
          ))}
        </div>
      ) : null}

      <div className="mx-auto w-full max-w-3xl px-4 pb-2">
        <div className="rounded-2xl border border-line bg-panel px-3 pb-2 pt-3 shadow-card">
          <label htmlFor="basic-chat-composer" className="sr-only">
            Message AI
          </label>
          <textarea
            id="basic-chat-composer"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Message AI"
            rows={1}
            className="custom-scrollbar max-h-[25vh] w-full resize-none overflow-y-auto bg-transparent px-2 text-[15px] leading-6 text-text outline-none placeholder:text-subtle focus-visible:shadow-focus"
          />

          <div className="mt-2 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <IconButton
                icon="attach_file"
                label="Attach images"
                onClick={onAttachClick}
                disabled={attachDisabled}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={onAttachFiles}
                aria-hidden="true"
                tabIndex={-1}
              />
              <span className="max-w-[120px] truncate text-xs font-medium text-subtle">
                {activeModelName || "No model"}
              </span>
            </div>

            <div className="flex items-center gap-2">
              {isSending ? (
                <IconButton icon="stop" label="Stop generating" onClick={onStop} />
              ) : null}
              <button
                type="button"
                onClick={onSend}
                disabled={!canSend}
                aria-label="Send message"
                className={cn(
                  "flex size-10 items-center justify-center rounded-full transition focus-visible:shadow-focus focus-visible:outline-none",
                  canSend
                    ? "bg-lime text-on-lime hover:brightness-95"
                    : "cursor-not-allowed bg-raised text-subtle",
                )}
              >
                <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                  arrow_upward
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

ChatComposer.propTypes = {
  draft: PropTypes.string.isRequired,
  onDraftChange: PropTypes.func.isRequired,
  onKeyDown: PropTypes.func.isRequired,
  attachments: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string.isRequired,
    }),
  ).isRequired,
  onRemoveAttachment: PropTypes.func.isRequired,
  onAttachClick: PropTypes.func.isRequired,
  onAttachFiles: PropTypes.func.isRequired,
  fileInputRef: PropTypes.shape({ current: PropTypes.object }).isRequired,
  attachDisabled: PropTypes.bool.isRequired,
  activeModelName: PropTypes.string,
  isSending: PropTypes.bool.isRequired,
  onStop: PropTypes.func.isRequired,
  canSend: PropTypes.bool.isRequired,
  onSend: PropTypes.func.isRequired,
};
