"use client";

import { useState, useEffect, useCallback } from "react";
import { useNotificationStore } from "@/store/notificationStore";
import { validateKeyName } from "../endpointLogic";

/** Parse a JSON body without throwing (empty/HTML error bodies → null). */
const readJson = (res) => res.json().catch(() => null);

/**
 * API-key state for the endpoint page: list (with first-run "Default Key"
 * auto-provision), create (plain text captured once into `revealed`), rename,
 * pause / resume, delete, visibility, and the pause-confirm payload the parent
 * renders. Clipboard stays in the parent via useCopyToClipboard — not here.
 *
 * Errors: `error` = list load failure; `createError` = inline under the create
 * field (cleared on edit/close); `renameErrors[id]` = inline per row; delete /
 * pause / resume failures go to the notification toast. No optimistic updates:
 * local state changes only after the server confirms.
 *
 * @returns {object} keys, loading, error, modal/new-name state + createError,
 * revealed + dismissRevealed, visibleKeys + toggleVisibility, togglingId,
 * deletingId, renamingId + renameErrors, confirmState + confirmPauseKey, and
 * the fetch/create/rename/toggle/delete actions.
 */
export function useApiKeys() {
  const notifyError = useNotificationStore((s) => s.error);
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAddModal, setShowAddModalState] = useState(false);
  const [newKeyName, setNewKeyNameState] = useState("");
  const [createError, setCreateError] = useState(null);
  /** Just-created key, one-time reveal: { id, name, plain } | null. */
  const [revealed, setRevealed] = useState(null);
  const [visibleKeys, setVisibleKeys] = useState(new Set());
  const [confirmState, setConfirmState] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  /** Inline rename errors keyed by key id. */
  const [renameErrors, setRenameErrors] = useState({});

  const fetchKeys = useCallback(async () => {
    const res = await fetch("/api/keys");
    const data = await readJson(res);
    if (!res.ok) throw new Error(data?.error || "Failed to load API keys.");
    return data?.keys || [];
  }, []);

  const refresh = useCallback(async () => {
    try {
      setKeys(await fetchKeys());
      setError(null);
    } catch (err) {
      setError(err?.message || "Failed to load API keys.");
    }
  }, [fetchKeys]);

  useEffect(() => {
    (async () => {
      try {
        let existing = await fetchKeys();
        // Auto-provision a default key for first-time users so the endpoint works out of the box.
        if (existing.length === 0) {
          try {
            const createRes = await fetch("/api/keys", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: "Default Key" }),
            });
            if (createRes.ok) existing = await fetchKeys();
          } catch {
            /* provisioning is best-effort; the empty list still renders */
          }
        }
        setKeys(existing);
      } catch (err) {
        setError(err?.message || "Failed to load API keys.");
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchKeys]);

  /** Editing the name clears the inline create error. */
  const setNewKeyName = (value) => {
    setNewKeyNameState(value);
    setCreateError(null);
  };

  /** Opening or closing the modal starts from a clean error state. */
  const setShowAddModal = (open) => {
    setShowAddModalState(open);
    setCreateError(null);
  };

  const createKey = async () => {
    const nameError = validateKeyName(newKeyName);
    if (nameError) {
      setCreateError(nameError);
      return;
    }
    const name = newKeyName.trim();
    setCreateError(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setCreateError(data?.error || "Failed to create API key.");
        return;
      }
      setRevealed({
        id: data?.id || data?.key?.id,
        name: data?.name || name,
        plain: typeof data?.key === "string" ? data.key : data?.plain || "",
      });
      setNewKeyNameState("");
      setShowAddModalState(false);
      await refresh();
    } catch (err) {
      setCreateError(err?.message || "Failed to create API key.");
    }
  };

  const clearRenameError = (id) =>
    setRenameErrors((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _removed, ...rest } = prev;
      return rest;
    });

  /**
   * Rename a key. Validates client-side with the same rule as the API.
   * @param {string} id
   * @param {string} name
   * @returns {Promise<boolean>} true when saved, so the row can leave edit mode.
   */
  const renameKey = async (id, name) => {
    const nameError = validateKeyName(name);
    if (nameError) {
      setRenameErrors((prev) => ({ ...prev, [id]: nameError }));
      return false;
    }
    clearRenameError(id);
    setRenamingId(id);
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setRenameErrors((prev) => ({ ...prev, [id]: data?.error || "Failed to rename API key." }));
        return false;
      }
      const saved = data?.key?.name ?? name.trim();
      setKeys((prev) => prev.map((k) => (k.id === id ? { ...k, name: saved } : k)));
      return true;
    } catch (err) {
      setRenameErrors((prev) => ({ ...prev, [id]: err?.message || "Failed to rename API key." }));
      return false;
    } finally {
      setRenamingId(null);
    }
  };

  const deleteKey = async (id) => {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await readJson(res);
        notifyError(data?.error || "Failed to delete API key.");
        return;
      }
      setKeys((prev) => prev.filter((k) => k.id !== id));
      setVisibleKeys((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      clearRenameError(id);
    } catch (err) {
      notifyError(err?.message || "Failed to delete API key.");
    } finally {
      setDeletingId(null);
    }
  };

  const toggleKey = async (id, isActive) => {
    const fallback = isActive ? "Failed to resume API key." : "Failed to pause API key.";
    setTogglingId(id);
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (!res.ok) {
        const data = await readJson(res);
        notifyError(data?.error || fallback);
        return;
      }
      setKeys((prev) => prev.map((k) => (k.id === id ? { ...k, isActive } : k)));
    } catch (err) {
      notifyError(err?.message || fallback);
    } finally {
      setTogglingId(null);
    }
  };

  const toggleVisibility = (keyId) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(keyId)) next.delete(keyId);
      else next.add(keyId);
      return next;
    });
  };

  const dismissRevealed = () => setRevealed(null);

  /**
   * Build the pause-confirm payload for a key; the parent renders it in a
   * ConfirmDialog. Confirm pauses the key then clears.
   * @param {{ id: string, name: string }} apiKey
   */
  const confirmPauseKey = (apiKey) => {
    setConfirmState({
      title: "Pause API Key",
      message: `Pause API key "${apiKey.name}"?\n\nThis key will stop working immediately but can be resumed later.`,
      onConfirm: async () => {
        setConfirmState(null);
        await toggleKey(apiKey.id, false);
      },
    });
  };

  return {
    keys,
    loading,
    error,
    showAddModal,
    setShowAddModal,
    newKeyName,
    setNewKeyName,
    createError,
    setCreateError,
    revealed,
    dismissRevealed,
    visibleKeys,
    toggleVisibility,
    confirmState,
    setConfirmState,
    confirmPauseKey,
    togglingId,
    deletingId,
    renamingId,
    renameErrors,
    clearRenameError,
    fetchKeys: refresh,
    createKey,
    renameKey,
    deleteKey,
    toggleKey,
  };
}
