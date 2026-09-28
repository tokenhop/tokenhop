"use client";

import { useCallback, useRef, useState } from "react";
import { chatTextValue, readAssistantText } from "./chatHelpers";
import { buildOutgoingMessages, requestErrorText, toRequestMessages } from "./chatSession";

/**
 * Own the send/stream lifecycle for basic chat: optimistic user + streaming
 * assistant messages, SSE parsing over POST /api/dashboard/chat/completions,
 * non-stream fallback, abort/stop, and error state.
 */
export default function useChatSend({
  model,
  onEnsureSession,
  onPatchSession,
  updateSession,
  setLoadError,
}) {
  const [attachments, setAttachments] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const abortRef = useRef(null);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const removeAttachment = useCallback((attachmentId) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== attachmentId));
  }, []);

  const streamIntoSession = useCallback(
    async (reader, targetSessionId, assistantMessageId, userText, finalizeTitle) => {
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          try {
            const text = readAssistantText(JSON.parse(payload));
            if (!text) continue;

            assistantText += text;
            const snapshot = assistantText;
            setStreamingText(snapshot);
            updateSession(targetSessionId, (current) => ({
              ...current,
              messages: current.messages.map((message) =>
                message.id === assistantMessageId
                  ? { ...message, content: snapshot, status: "streaming" }
                  : message,
              ),
              updatedAt: new Date().toISOString(),
            }));
          } catch {
            // Ignore malformed chunks.
          }
        }
      }

      updateSession(targetSessionId, (current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === assistantMessageId
            ? { ...message, content: assistantText || message.content, status: "done" }
            : message,
        ),
        updatedAt: new Date().toISOString(),
      }));
      finalizeTitle(targetSessionId, userText);
    },
    [updateSession],
  );

  const failAssistantMessage = useCallback(
    (targetSessionId, assistantMessageId, error) => {
      const errorText = chatTextValue(error?.message || error);
      updateSession(targetSessionId, (current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === assistantMessageId
            ? { ...message, content: message.content || `Error: ${errorText}`, status: "error" }
            : message,
        ),
        updatedAt: new Date().toISOString(),
      }));
      setLoadError(errorText || "Failed to send message.");
    },
    [updateSession, setLoadError],
  );

  const sendMessage = useCallback(
    async ({ text, attachments: staged }) => {
      if (!model) return;
      const userText = text.trim();
      if (!userText && staged.length === 0) return;

      const target = onEnsureSession(model);
      if (!target) return;
      const targetSessionId = target.id;

      const { userMessage, assistantMessage } = buildOutgoingMessages({
        text: userText,
        attachments: staged,
      });
      const assistantMessageId = assistantMessage.id;
      const nextMessages = [...target.messages, userMessage, assistantMessage];
      onPatchSession(targetSessionId, model, nextMessages, userText);
      setAttachments([]);
      setIsSending(true);
      setStreamingMessageId(assistantMessageId);
      setStreamingText("");
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch("/api/dashboard/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            model: model.requestModel || model.id,
            messages: toRequestMessages(nextMessages, assistantMessageId),
            stream: true,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(requestErrorText(errorData, response.status));
        }

        const reader = response.body?.getReader();
        if (!reader) {
          const data = await response.json().catch(() => ({}));
          const fallbackText = chatTextValue(
            data?.choices?.[0]?.message?.content ||
              data?.output_text ||
              data?.error ||
              data?.message ||
              "",
          );
          updateSession(targetSessionId, (current) => ({
            ...current,
            messages: current.messages.map((message) =>
              message.id === assistantMessageId
                ? { ...message, content: fallbackText, status: "done" }
                : message,
            ),
            updatedAt: new Date().toISOString(),
          }));
          return;
        }

        await streamIntoSession(
          reader,
          targetSessionId,
          assistantMessageId,
          userText,
          target.finalizeTitle,
        );
      } catch (error) {
        if (error?.name === "AbortError") return;
        failAssistantMessage(targetSessionId, assistantMessageId, error);
      } finally {
        setIsSending(false);
        setStreamingMessageId("");
        setStreamingText("");
        abortRef.current = null;
      }
    },
    [
      model,
      onEnsureSession,
      onPatchSession,
      updateSession,
      streamIntoSession,
      failAssistantMessage,
    ],
  );

  return {
    attachments,
    setAttachments,
    isSending,
    streamingMessageId,
    streamingText,
    handleStop,
    removeAttachment,
    sendMessage,
  };
}
