"use client";

import {
  buildUserContent,
  chatTextValue,
  createId,
  makeChatSessionTitle,
  safeParse,
} from "./chatHelpers";

/** localStorage keys for basic chat persistence. */
export const STORAGE_KEYS = {
  sessions: "basic-chat.sessions",
  activeSessionId: "basic-chat.activeSessionId",
  activeProviderId: "basic-chat.activeProviderId",
  draft: "basic-chat.draft",
};

/** Load persisted sessions (browser only; `[]` on server or corrupt data). */
export function loadSessions() {
  if (typeof window === "undefined") return [];
  try {
    const saved = safeParse(globalThis.localStorage.getItem(STORAGE_KEYS.sessions), []);
    return Array.isArray(saved)
      ? saved.map((session) => ({
          ...session,
          messages: Array.isArray(session.messages) ? session.messages : [],
        }))
      : [];
  } catch {
    return [];
  }
}

/** Load a persisted string value (browser only; `""` on server). */
export function loadString(key) {
  if (typeof window === "undefined") return "";
  return globalThis.localStorage.getItem(key) || "";
}

/** Persist chat state; storage errors (private mode, quota) are ignored. */
export function persistChatState({ sessions, activeSessionId, activeProviderId, draft }) {
  try {
    globalThis.localStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify(sessions));
    globalThis.localStorage.setItem(STORAGE_KEYS.activeSessionId, activeSessionId);
    globalThis.localStorage.setItem(STORAGE_KEYS.activeProviderId, activeProviderId);
    globalThis.localStorage.setItem(STORAGE_KEYS.draft, draft);
  } catch {
    // Ignore storage errors.
  }
}

/** Build a blank session bound to a model. */
export function ensureSessionForModel(model) {
  if (!model) return null;
  const now = new Date().toISOString();
  return {
    id: createId(),
    title: "New chat",
    providerId: model.providerId,
    providerName: model.providerName,
    modelId: model.id,
    modelName: model.name,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

/** Build the user + placeholder assistant messages for one send. */
export function buildOutgoingMessages({ text, attachments }) {
  const userMessage = {
    id: createId(),
    role: "user",
    content: text,
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      type: attachment.type,
      dataUrl: attachment.dataUrl,
    })),
    createdAt: new Date().toISOString(),
  };
  const assistantMessage = {
    id: createId(),
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString(),
    status: "streaming",
  };
  return { userMessage, assistantMessage };
}

/** Title a session from the first user text, keeping an existing custom title. */
export function titleFor(title, seed) {
  return title === "New chat" ? makeChatSessionTitle(seed) : title;
}

/** Map stored messages to the chat-completions request shape. */
export function toRequestMessages(messages, assistantMessageId) {
  return messages
    .filter((message) => !(message.role === "assistant" && message.id === assistantMessageId))
    .map((message) => ({
      role: message.role,
      content: message.role === "user" ? buildUserContent(message) : message.content,
    }));
}

/** Human-readable request failure from a non-OK response payload. */
export function requestErrorText(errorData, status) {
  return chatTextValue(errorData.error || errorData.message || `Request failed (${status})`);
}
