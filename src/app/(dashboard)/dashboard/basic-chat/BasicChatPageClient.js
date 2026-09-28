"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Callout } from "@/shared/components";
import ChatComposer from "./ChatComposer";
import ChatHistoryMenu from "./ChatHistoryMenu";
import ChatMessageList from "./ChatMessageList";
import ChatModelPicker from "./ChatModelPicker";
import { cloneSession, createId, fileToDataUrl } from "./chatHelpers";
import {
  ensureSessionForModel,
  loadSessions,
  loadString,
  persistChatState,
  STORAGE_KEYS,
  titleFor,
} from "./chatSession";
import useChatProviders from "./useChatProviders";
import useChatSend from "./useChatSend";

/** Hidden basic chat: provider/model switching, SSE streaming, image attachments. */
export default function BasicChatPageClient() {
  const { providerGroups, loadingData, loadError, setLoadError } = useChatProviders();
  const [sessions, setSessions] = useState(loadSessions);
  const [activeSessionId, setActiveSessionId] = useState(() =>
    loadString(STORAGE_KEYS.activeSessionId),
  );
  const [activeProviderId, setActiveProviderId] = useState(() =>
    loadString(STORAGE_KEYS.activeProviderId),
  );
  const [activeModelId, setActiveModelId] = useState("");
  const [draft, setDraft] = useState(() => loadString(STORAGE_KEYS.draft));
  const [isHydrated, setIsHydrated] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const fileInputRef = useRef(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  const modelIndex = useMemo(() => {
    const map = new Map();
    for (const group of providerGroups) {
      for (const model of group.models) {
        map.set(model.id, {
          ...model,
          providerId: group.providerId,
          providerName: group.providerName,
        });
      }
    }
    return map;
  }, [providerGroups]);

  const activeProviderGroup = useMemo(() => {
    return (
      providerGroups.find((group) => group.providerId === activeProviderId) ||
      providerGroups[0] ||
      null
    );
  }, [providerGroups, activeProviderId]);

  const activeModel = useMemo(() => {
    if (activeModelId && modelIndex.has(activeModelId)) return modelIndex.get(activeModelId);
    if (activeSessionId) {
      const session = sessions.find((item) => item.id === activeSessionId);
      if (session?.modelId && modelIndex.has(session.modelId))
        return modelIndex.get(session.modelId);
    }
    return activeProviderGroup?.models?.[0] || null;
  }, [activeModelId, modelIndex, activeProviderGroup, sessions, activeSessionId]);

  const currentMessages =
    sessions.find((session) => session.id === activeSessionId)?.messages || [];
  const sessionItems = useMemo(
    () =>
      [...sessions].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [sessions],
  );

  useEffect(() => {
    if (!isHydrated) return;
    persistChatState({ sessions, activeSessionId, activeProviderId, draft });
  }, [isHydrated, sessions, activeSessionId, activeProviderId, draft]);

  useEffect(() => {
    if (!isHydrated || loadingData || initializedRef.current) return;
    if (providerGroups.length === 0) return;

    const savedProvider =
      providerGroups.find((group) => group.providerId === activeProviderId) || providerGroups[0];
    const savedModel =
      activeModelId && modelIndex.has(activeModelId)
        ? modelIndex.get(activeModelId)
        : savedProvider.models[0];

    if (sessions.length > 0) {
      const session = sessions.find((item) => item.id === activeSessionId) || sessions[0];
      const sessionModel =
        session?.modelId && modelIndex.has(session.modelId)
          ? modelIndex.get(session.modelId)
          : savedModel;
      initializedRef.current = true;
      setActiveSessionId(session.id);
      setActiveProviderId(sessionModel?.providerId || savedProvider.providerId);
      setActiveModelId(sessionModel?.id || savedModel.id);
      return;
    }

    const session = ensureSessionForModel(savedModel);
    session.providerId = savedProvider.providerId;
    session.providerName = savedProvider.providerName;
    session.modelId = savedModel.id;
    session.modelName = savedModel.name;

    initializedRef.current = true;
    setSessions([session]);
    setActiveSessionId(session.id);
    setActiveProviderId(savedProvider.providerId);
    setActiveModelId(savedModel.id);
  }, [
    isHydrated,
    loadingData,
    providerGroups,
    modelIndex,
    sessions,
    activeSessionId,
    activeProviderId,
    activeModelId,
  ]);

  const updateSession = useCallback((sessionId, updater) => {
    setSessions((prev) =>
      prev.map((session) => (session.id === sessionId ? updater(cloneSession(session)) : session)),
    );
  }, []);

  const finalizeSessionTitle = useCallback(
    (sessionId, titleSeed) => {
      updateSession(sessionId, (session) => ({
        ...session,
        title: titleFor(session.title, titleSeed),
        updatedAt: new Date().toISOString(),
      }));
    },
    [updateSession],
  );

  const onEnsureSession = useCallback(
    (model) => {
      const existing = sessions.find((item) => item.id === activeSessionId);
      if (existing) {
        return {
          id: existing.id,
          messages: existing.messages || [],
          finalizeTitle: finalizeSessionTitle,
        };
      }
      const created = ensureSessionForModel(model);
      if (!created) return null;
      setSessions((prev) => [created, ...prev]);
      setActiveSessionId(created.id);
      return { id: created.id, messages: [], finalizeTitle: finalizeSessionTitle };
    },
    [sessions, activeSessionId, finalizeSessionTitle],
  );

  const onPatchSession = useCallback((sessionId, model, nextMessages, userText) => {
    setSessions((prev) =>
      prev.map((item) =>
        item.id === sessionId
          ? {
              ...item,
              providerId: model.providerId,
              providerName: model.providerName,
              modelId: model.id,
              modelName: model.name,
              messages: nextMessages,
              updatedAt: new Date().toISOString(),
              title: titleFor(item.title, userText),
            }
          : item,
      ),
    );
  }, []);

  const {
    attachments,
    setAttachments,
    isSending,
    streamingMessageId,
    streamingText,
    handleStop,
    removeAttachment,
    sendMessage,
  } = useChatSend({
    model: activeModel || activeProviderGroup?.models?.[0] || null,
    onEnsureSession,
    onPatchSession,
    updateSession,
    setLoadError,
  });

  const canSend =
    !isSending && !!activeModel && (draft.trim().length > 0 || attachments.length > 0);

  const handleSend = useCallback(() => {
    if (!canSend) return;
    sendMessage({ text: draft, attachments });
    setDraft("");
  }, [canSend, sendMessage, draft, attachments]);

  const handleSelectSession = useCallback(
    (sessionId) => {
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) return;
      setActiveSessionId(sessionId);
      setActiveProviderId(session.providerId || activeProviderId);
      setActiveModelId(session.modelId || activeModelId);
      setHistoryOpen(false);
    },
    [sessions, activeProviderId, activeModelId],
  );

  const handleDeleteCurrentChat = useCallback(() => {
    if (!activeSessionId) return;
    const nextSessions = sessions.filter((session) => session.id !== activeSessionId);
    const fallback = nextSessions[0] || null;
    setSessions(nextSessions);
    if (fallback) {
      setActiveSessionId(fallback.id);
      setActiveProviderId(fallback.providerId);
      setActiveModelId(fallback.modelId);
    } else {
      setActiveSessionId("");
      setActiveProviderId("");
      setActiveModelId("");
    }
  }, [activeSessionId, sessions]);

  const bindModelToSession = useCallback(
    (model) => {
      const current = sessions.find((session) => session.id === activeSessionId);
      if (current && current.messages.length > 0) {
        const session = ensureSessionForModel(model);
        if (!session) return;
        setSessions((prev) => [session, ...prev]);
        setActiveSessionId(session.id);
      } else if (current) {
        updateSession(current.id, (session) => ({
          ...session,
          providerId: model.providerId,
          providerName: model.providerName,
          modelId: model.id,
          modelName: model.name,
        }));
        setActiveSessionId(current.id);
      } else {
        const session = ensureSessionForModel(model);
        if (!session) return;
        setSessions((prev) => [session, ...prev]);
        setActiveSessionId(session.id);
      }

      setActiveProviderId(model.providerId);
      setActiveModelId(model.id);
      setModelMenuOpen(false);
    },
    [sessions, activeSessionId, updateSession],
  );

  const handleSelectModel = useCallback(
    (modelId) => {
      const model = modelIndex.get(modelId);
      if (model) bindModelToSession(model);
    },
    [modelIndex, bindModelToSession],
  );

  const handleAttachFiles = useCallback(
    async (event) => {
      const files = Array.from(event.target.files || []);
      if (files.length === 0) return;

      const images = files.filter((file) => file.type.startsWith("image/"));
      if (images.length === 0) {
        setLoadError("Only image attachments are supported.");
        event.target.value = "";
        return;
      }

      const converted = await Promise.all(
        images.map(async (file) => ({
          id: createId(),
          name: file.name,
          type: file.type,
          size: file.size,
          dataUrl: await fileToDataUrl(file),
        })),
      );

      setAttachments((prev) => [...prev, ...converted]);
      event.target.value = "";
    },
    [setAttachments, setLoadError],
  );

  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (canSend) handleSend();
      }
    },
    [canSend, handleSend],
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg text-text">
      <h1 className="sr-only">Basic chat</h1>
      <div className="relative mx-auto flex h-full min-h-0 w-full max-w-4xl flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-3 lg:px-6">
          <ChatModelPicker
            providerGroups={providerGroups}
            activeModel={activeModel}
            activeModelId={activeModel?.id || activeModelId}
            loadingData={loadingData}
            isOpen={modelMenuOpen}
            onOpenChange={setModelMenuOpen}
            onSelectModel={handleSelectModel}
          />

          <div className="flex items-center gap-2">
            <ChatHistoryMenu
              sessions={sessionItems}
              activeSessionId={activeSessionId}
              isOpen={historyOpen}
              onOpenChange={setHistoryOpen}
              onSelectSession={handleSelectSession}
            />
            <Button
              variant="ghost"
              size="sm"
              icon="delete"
              onClick={handleDeleteCurrentChat}
              disabled={!activeSessionId || sessions.length === 0}
            >
              Clear
            </Button>
          </div>
        </div>

        {loadError ? (
          <div className="shrink-0 px-4 lg:px-6">
            <Callout variant="err" title="Something went wrong">
              {loadError}
            </Callout>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col">
          <div
            role="log"
            aria-live="polite"
            aria-label="Conversation"
            className="custom-scrollbar flex-1 overflow-y-auto py-4"
          >
            <ChatMessageList
              messages={currentMessages}
              streamingMessageId={streamingMessageId}
              streamingText={streamingText}
              assistantName={activeModel?.name}
            />
          </div>

          <ChatComposer
            draft={draft}
            onDraftChange={setDraft}
            onKeyDown={handleKeyDown}
            attachments={attachments}
            onRemoveAttachment={removeAttachment}
            onAttachClick={() => fileInputRef.current?.click()}
            onAttachFiles={handleAttachFiles}
            fileInputRef={fileInputRef}
            attachDisabled={!activeModel || loadingData}
            activeModelName={activeModel?.name}
            isSending={isSending}
            onStop={handleStop}
            canSend={canSend}
            onSend={handleSend}
          />

          <p className="mx-auto mt-2 max-w-3xl px-4 pb-4 text-center text-xs text-subtle">
            Model list is filtered from connected providers.
          </p>
        </div>
      </div>
    </div>
  );
}
