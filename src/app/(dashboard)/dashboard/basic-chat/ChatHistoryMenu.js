"use client";

import PropTypes from "prop-types";
import { useCallback, useRef } from "react";
import { EmptyState } from "@/shared/components";
import { cn } from "@/shared/utils/cn";
import { chatTextValue, formatRelativeTime } from "./chatHelpers";
import useMenuDismiss from "./useMenuDismiss";

const MENU_ID = "basic-chat-history-menu";

/** Conversation history popup for basic chat, newest first, coral selection. */
export default function ChatHistoryMenu({
  sessions,
  activeSessionId,
  isOpen,
  onOpenChange,
  onSelectSession,
}) {
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  useMenuDismiss(isOpen, close, triggerRef, panelRef);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={MENU_ID}
        onClick={() => onOpenChange(!isOpen)}
        className="flex min-h-11 items-center gap-2 rounded-xl border border-line bg-panel px-4 text-sm font-medium text-muted shadow-card transition-colors hover:bg-raised hover:text-text focus-visible:shadow-focus focus-visible:outline-none"
      >
        <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
          history
        </span>
        History
      </button>

      {isOpen ? (
        <div
          ref={panelRef}
          id={MENU_ID}
          role="dialog"
          aria-label="Recent chats"
          className="signal-overlay-menu absolute end-4 top-[72px] z-30 w-[min(360px,calc(100vw-2rem))] rounded-2xl border border-line bg-panel p-2 shadow-card lg:end-6"
        >
          <div className="px-3 py-2">
            <p className="font-mono text-xs uppercase tracking-wider text-subtle">Recent chats</p>
          </div>
          <div className="custom-scrollbar max-h-[48vh] space-y-2 overflow-y-auto p-1">
            {sessions.length === 0 ? (
              <EmptyState icon="forum" title="No conversations yet" />
            ) : (
              sessions.map((session) => {
                const isActive = session.id === activeSessionId;
                const latestMessage =
                  [...(session.messages || [])]
                    .reverse()
                    .find((message) => message.role === "user") || session.messages?.[0];
                return (
                  <button
                    key={session.id}
                    type="button"
                    aria-current={isActive || undefined}
                    onClick={() => onSelectSession(session.id)}
                    className={cn(
                      "w-full rounded-xl border px-3 py-2.5 text-start transition-colors focus-visible:shadow-focus focus-visible:outline-none",
                      isActive ? "border-coral bg-coral-bg" : "border-line bg-raised hover:bg-bg",
                    )}
                  >
                    <span className="flex items-start justify-between gap-3">
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            "block truncate text-sm font-medium",
                            isActive ? "text-coral-ink" : "text-text",
                          )}
                        >
                          {session.title}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted">
                          {chatTextValue(latestMessage?.content) || "Empty chat"}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-subtle">
                        {formatRelativeTime(session.updatedAt)}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

ChatHistoryMenu.propTypes = {
  sessions: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      title: PropTypes.string,
      updatedAt: PropTypes.string,
      messages: PropTypes.array,
    }),
  ).isRequired,
  activeSessionId: PropTypes.string.isRequired,
  isOpen: PropTypes.bool.isRequired,
  onOpenChange: PropTypes.func.isRequired,
  onSelectSession: PropTypes.func.isRequired,
};
