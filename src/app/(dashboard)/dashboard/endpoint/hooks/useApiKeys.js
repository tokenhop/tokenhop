"use client";

import { useState, useEffect, useCallback } from "react";
import { useNotificationStore } from "@/store/notificationStore";
import {
  validateKeyName,
  parseModelScope,
  parseComboScope,
  expiryToIso,
  validateExpiry,
} from "../endpointLogic";
import { useKeyBudget } from "./useKeyBudget";
import {
  LEGACY_CONTEXT,
  readJson,
  loadKeyContext,
  loadKeyList,
  acknowledgeMigration,
} from "./keyApi";

// Re-exported: KeysSummary / useToolSetupData / tests import the loaders from here.
export { loadKeyContext, loadKeyList, acknowledgeMigration };

/**
 * API-key state for the endpoint page: storage-context bootstrap
 * (`GET /api/keys/context`), list (legacy first-run "Default Key"
 * auto-provision stays legacy-only), create (plain text captured once into
 * `revealed`; hashed mode adds type/model-scope/expiry), rename, pause /
 * resume, delete, visibility, and the pause-confirm payload the parent
 * renders. Clipboard stays in the parent via useCopyToClipboard — not here.
 *
 * Hashed mode (storage "hashed"): every key call carries
 * `?workspaceId=<context workspaceId>`; the manager-only list is skipped for
 * members (no privilege probing), and no key is ever auto-provisioned.
 *
 * Errors: `error` = list load failure; `createError` = inline under the create
 * form (cleared on edit/close); `renameErrors[id]` = inline per row; delete /
 * pause / resume failures go to the notification toast. No optimistic updates:
 * local state changes only after the server confirms.
 *
 * @returns {object} context + hashedMode + capabilities, keys, loading, error,
 * modal/new-name state + createError, revealed + dismissRevealed, visibleKeys +
 * toggleVisibility, togglingId, deletingId, renamingId + renameErrors,
 * confirmState + confirmPauseKey, create-form state (type, models, expiry),
 * and the fetch/create/rename/toggle/delete actions.
 */
export function useApiKeys() {
  const notifyError = useNotificationStore((s) => s.error);
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [context, setContext] = useState(null);
  const [showAddModal, setShowAddModalState] = useState(false);
  const [newKeyName, setNewKeyNameState] = useState("");
  const [createError, setCreateError] = useState(null);
  /** Just-created key, one-time reveal: { id, name, plain, prefix? } | null. */
  const [revealed, setRevealed] = useState(null);
  const [visibleKeys, setVisibleKeys] = useState(new Set());
  const [confirmState, setConfirmState] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  /** Inline rename errors keyed by key id. */
  const [renameErrors, setRenameErrors] = useState({});
  // Hashed-mode create form (type / model scope / expiry).
  const [createType, setCreateType] = useState("user");
  const [createModels, setCreateModels] = useState("");
  const [createCombos, setCreateCombos] = useState("");
  const [createExpiry, setCreateExpiry] = useState("never");
  const [customExpiryDate, setCustomExpiryDate] = useState("");
  const keyBudget = useKeyBudget(context);
  const budgetFailure = keyBudget.budgetFailure;
  // Migration-notice dismissal (server flag is the authority; no localStorage).
  const [acknowledging, setAcknowledging] = useState(false);
  const [ackError, setAckError] = useState(null);

  /**
   * Manager-only dismissal: PATCH the durable spec214 flag, hide the notice
   * only on success. Members/viewers never render the action. Failure keeps
   * the notice and surfaces the nonsecret server literal.
   */
  const dismissMigrationNotice = async () => {
    setAcknowledging(true);
    setAckError(null);
    try {
      await acknowledgeMigration(context);
      // No optimistic flag writes elsewhere: context is the single source.
      setContext((current) => (current ? { ...current, migrationAcknowledged: true } : current));
    } catch (err) {
      setAckError(err?.message || "Could not dismiss the notice.");
    } finally {
      setAcknowledging(false);
    }
  };

  const hashedMode = context?.storage === "hashed";
  /** Mutation URL: hashed storage scopes every key call to the workspace. */
  const scopedUrl = useCallback(
    (path) =>
      hashedMode && context?.workspaceId
        ? `${path}?workspaceId=${encodeURIComponent(context.workspaceId)}`
        : path,
    [hashedMode, context],
  );

  const fetchKeys = useCallback(async () => loadKeyList(context ?? LEGACY_CONTEXT), [context]);

  const refresh = useCallback(async () => {
    try {
      setKeys(await fetchKeys());
      setError(null);
    } catch (err) {
      setError(err?.message || "Failed to load API keys.");
    }
  }, [fetchKeys]);

  // Bootstrap: storage context first, then the mode-appropriate list. The
  // prove-then-reveal rule applies when the context fell back to legacy:
  // allow the legacy UI only after a successful list proves the fallback,
  // so a context401 on a hashed instance cannot unlock mutations or the
  // Default provision POST. No error leaks beyond the existing list-error copy.
  useEffect(() => {
    (async () => {
      try {
        const ctx = await loadKeyContext();
        let existing = await loadKeyList(ctx);
        setContext(ctx);
        // Auto-provision a default key for first-time users so the endpoint
        // works out of the box. Legacy-only and only on the proven truthful
        // empty list: hashed mode never provisions.
        if (ctx.storage === "legacy" && existing.length === 0) {
          try {
            const createRes = await fetch("/api/keys", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: "Default Key" }),
            });
            if (createRes.ok) existing = await loadKeyList(ctx);
          } catch {
            /* provisioning is best-effort; the empty list still renders */
          }
        }
        setKeys(existing);
        setError(null);
      } catch (err) {
        // Error state before any context — capabilities stay closed.
        setError(err?.message || "Failed to load API keys.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  /** Editing the name clears the inline create error. */
  const setNewKeyName = (value) => {
    setNewKeyNameState(value);
    setCreateError(null);
  };

  /** Reset the hashed create-form extras (name is reset by the parent). */
  const resetCreateForm = () => {
    setCreateType("user");
    setCreateModels("");
    setCreateCombos("");
    setCreateExpiry("never");
    setCustomExpiryDate("");
    keyBudget.resetBudgetForm();
    setCreateError(null);
  };

  /** Opening or closing the modal starts from a clean error state. */
  const setShowAddModal = (open) => {
    setShowAddModalState(open);
    setCreateError(null);
    if (!open) resetCreateForm();
  };

  const createKey = async () => {
    const nameError = validateKeyName(newKeyName);
    if (nameError) {
      setCreateError(nameError);
      return;
    }
    const name = newKeyName.trim();
    setCreateError(null);
    keyBudget.clearBudgetFailure();
    const workspaceId = context?.workspaceId; // captured: retry targets this workspace

    // Hashed mode: type / model + combo scope / expiry ride along; the
    // member-safe type is forced server-side, the client hides Service unless allowed.
    let body = { name };
    let budget = null;
    if (hashedMode) {
      const parsed = parseModelScope(createModels);
      if (parsed.error) {
        setCreateError(parsed.error);
        return;
      }
      const comboParsed = parseComboScope(createCombos);
      if (comboParsed.error) {
        setCreateError(comboParsed.error);
        return;
      }
      const expiresAt = expiryToIso(createExpiry, customExpiryDate);
      const expiryError = validateExpiry(expiresAt);
      if (expiryError) {
        setCreateError(expiryError);
        return;
      }
      const parsedBudget = keyBudget.parseBudgetInput();
      if (parsedBudget.error) {
        setCreateError(parsedBudget.error);
        return;
      }
      budget = parsedBudget.budget;
      body = {
        name,
        type: context?.canCreateService ? createType : "user",
        allowedModels: parsed.models ?? [],
        allowedCombos: comboParsed.combos ?? [],
        expiresAt,
      };
    }

    try {
      const res = await fetch(scopedUrl("/api/keys"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setCreateError(data?.error || "Failed to create API key.");
        return;
      }
      const keyId = data?.id || data?.key?.id;
      setRevealed({
        id: keyId,
        name: data?.name || name,
        plain: typeof data?.key === "string" ? data.key : data?.plain || "",
        prefix: typeof data?.metadata?.prefix === "string" ? data.metadata.prefix : null,
      });
      setNewKeyNameState("");
      resetCreateForm();
      setShowAddModalState(false);
      await keyBudget.saveBudget(keyId, budget, workspaceId);
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
      const res = await fetch(scopedUrl(`/api/keys/${id}`), {
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
      const res = await fetch(scopedUrl(`/api/keys/${id}`), { method: "DELETE" });
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
      const res = await fetch(scopedUrl(`/api/keys/${id}`), {
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

  const dismissRevealed = () => {
    setRevealed(null);
    keyBudget.clearBudgetFailure();
  };

  /**
   * Build the pause-confirm payload for a key; the parent renders it in a
   * ConfirmDialog. Confirm pauses the key then clears.
   * @param {{ id: string, name: string }} apiKey
   */
  const confirmPauseKey = (apiKey) => {
    setConfirmState({
      title: "Pause API key",
      message: `Pause API key "${apiKey.name}"?\n\nThis key will stop working immediately but can be resumed later.`,
      onConfirm: async () => {
        setConfirmState(null);
        await toggleKey(apiKey.id, false);
      },
    });
  };

  return {
    context: context ?? LEGACY_CONTEXT,
    hashedMode,
    /** True once a successful list has confirmed the context behind it. */
    contextReady: Boolean(context),
    capabilities: {
      // Failed bootstrap (context null) fails closed: no Create affordance
      // until a successful context+list proves the fallback.
      canCreate: context?.canCreate ?? false,
      canManage: context?.canManage ?? false,
      canCreateService: context?.canCreateService ?? false,
    },
    keys,
    loading,
    error,
    showAddModal,
    setShowAddModal,
    newKeyName,
    setNewKeyName,
    createError,
    setCreateError,
    createType,
    setCreateType,
    createModels,
    setCreateModels,
    createCombos,
    setCreateCombos,
    createExpiry,
    setCreateExpiry,
    customExpiryDate,
    setCustomExpiryDate,
    createBudgetUsd: keyBudget.createBudgetUsd,
    setCreateBudgetUsd: keyBudget.setCreateBudgetUsd,
    createBudgetWindow: keyBudget.createBudgetWindow,
    setCreateBudgetWindow: keyBudget.setCreateBudgetWindow,
    budgetFailure,
    retryBudget: keyBudget.retryBudget,
    revealed,
    dismissRevealed,
    migrationNotice: {
      visible: hashedMode && context?.migrationAcknowledged !== true,
      canDismiss: context?.canManage === true,
      dismissing: acknowledging,
      error: ackError,
      dismiss: dismissMigrationNotice,
    },
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
