"use client";

import PropTypes from "prop-types";
import Image from "next/image";
import { EmptyState } from "@/shared/components";
import { cn } from "@/shared/utils/cn";
import { chatTextValue } from "./chatHelpers";

/** Scrollable conversation: user bubbles at the inline end, live `role="log"` region. */
export default function ChatMessageList({
  messages,
  streamingMessageId,
  streamingText,
  assistantName,
}) {
  if (messages.length === 0) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center px-4">
        <EmptyState
          icon="chat"
          title="Start a conversation"
          body="Simple chat interface to interact with any AI model from connected providers. Select a model and start chatting!"
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4">
      {messages.map((message) => {
        const isUser = message.role === "user";
        const isAssistant = message.role === "assistant";
        const isStreaming =
          isAssistant && message.id === streamingMessageId && message.status === "streaming";
        const content = chatTextValue(message.content) || (isAssistant ? streamingText : "");

        return (
          <div
            key={message.id}
            className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}
          >
            <div
              className={cn(
                "max-w-[min(88%,42rem)]",
                isUser
                  ? "rounded-2xl border border-line bg-raised px-4 py-3 shadow-card"
                  : "px-1 py-1",
              )}
            >
              <p className="mb-1 font-display text-xs font-semibold text-subtle">
                {isUser ? "You" : assistantName || "Assistant"}
              </p>

              {message.attachments?.length ? (
                <div className="mb-2 mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {message.attachments.map((attachment) => (
                    <a
                      key={attachment.id}
                      href={attachment.dataUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="overflow-hidden rounded-xl border border-line bg-panel transition-colors hover:border-coral/60 focus-visible:shadow-focus focus-visible:outline-none"
                    >
                      <Image
                        src={attachment.dataUrl}
                        alt={attachment.name}
                        width={320}
                        height={112}
                        unoptimized
                        className="h-28 w-full object-cover"
                        loading="lazy"
                      />
                    </a>
                  ))}
                </div>
              ) : null}

              <div className="whitespace-pre-wrap break-words text-[15px] leading-7 text-text">
                {content}
                {isAssistant && isStreaming && !streamingText ? (
                  <span
                    aria-hidden="true"
                    className="ms-1 inline-block h-4 w-2 bg-coral align-middle motion-safe:animate-pulse"
                  />
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

ChatMessageList.propTypes = {
  messages: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      role: PropTypes.string.isRequired,
      content: PropTypes.oneOfType([PropTypes.string, PropTypes.array, PropTypes.object]),
      status: PropTypes.string,
      attachments: PropTypes.arrayOf(
        PropTypes.shape({
          id: PropTypes.string.isRequired,
          name: PropTypes.string,
          dataUrl: PropTypes.string.isRequired,
        }),
      ),
    }),
  ).isRequired,
  streamingMessageId: PropTypes.string.isRequired,
  streamingText: PropTypes.string.isRequired,
  assistantName: PropTypes.string,
};
