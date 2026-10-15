"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuthStatusState } from "@/shared/hooks/useAuthStatus";
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
  keyIdentity,
  keyIdentityReady,
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
 * Identity: the bootstrap (and any re-list) is identity-keyed, so a context,
 * a refresh or a bootstrap response that outlives its identity never serves
 * another user's keys. Before identity/auth is ready (except the existing
 * auth status bootstrap) no request starts and capabilities stay closed.
 *
 * @returns {object} context + hashedMode + capabilities, keys, loading, error,
 * modal/new-name state + createError, revealed + dismissRevealed, visibleKeys +
 * toggleVisibility, togglingId, deletingId, renamingId + renameErrors,
 * confirmState + confirmPauseKey, create-form state (type, models, expiry),
 * and the fetch/create/rename/toggle/delete actions.
 */
export function useApiKeys() {
  const { status: authStatus, loaded: authReady } = useAuthStatusState();
  const bootstrapIdentity = keyIdentity(authStatus);
  const ready = authReady && keyIdentityReady(authStatus);
  const notifyError = useNotificationStore((s) => s.error);
  /** Key list tagged with its identity: { id, list } — see bootstrap render guard. */
  const [keyState, setKeyState] = useState(null);
  const [loading, setLoading] = useState(true);
  /** List error tagged with the identity it belongs to: { id, message } | null. */
  const [errorState, setErrorState] = useState(null);
  const [rawContext, setContext] = useState(null);
  /** Identity (user + active workspace) the cached context belongs to. */
  const [bootstrapId, setBootstrapId] = useState(null);
  /** Latest render identity: stale refresh callers read this, never a capture. */
  const identityRef = useRef(null);
  identityRef.current = bootstrapIdentity;
  const context = ready && bootstrapId === bootstrapIdentity ? rawContext : null;
  /** Record (or clear) a list error for the current identity only. */
  const setError = useCallback((message) => {
    setErrorState(message ? { id: identityRef.current, message } : null);
  }, []);
  const error = errorState && errorState.id === bootstrapIdentity ? errorState.message : null;
  /**
   * Only the list loaded for the current identity is ever exposed: a prior
   * user's rows (or a metadata-only row, if storage changed mid-session)
   * never renders under a new identity. Writes land on the list of the
   * identity current when they apply; id-matched mutation updates
   * (rename/toggle/delete) cannot introduce another identity's rows.
   */
  const keys = keyState && keyState.id === bootstrapIdentity ? keyState.list : [];
  const setKeys = useCallback((next) => {
    const forId = identityRef.current;
    setKeyState((prev) => {
      const prevList = prev && prev.id === forId ? prev.list : [];
      return { id: forId, list: typeof next === "function" ? next(prevList) : next };
    });
  }, []);
  const [showAddModal, setShowAddModalState] = useState(false);
  const [newKeyName, setNewKeyNameState] = useState("");
  const [createError, setCreateError] = useState(null);
  // Rapid-create guard: the ref blocks re-entry synchronously (before the
  // first await), the state only feeds the dialog's loading/disabled UI.
  const creatingRef = useRef(false);
  const [creating, setCreating] = useState(false);
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

  const refresh = useCallback(async () => {
    const current = () =>
      ready && identityRef.current === bootstrapIdentity && bootstrapId === bootstrapIdentity;
    if (!current() || !context) return;
    try {
      const listed = await loadKeyList(context);
      if (!current()) return;
      setKeys(listed);
      setError(null);
    } catch (err) {
      if (current()) setError(err?.message || "Failed to load API keys.");
    }
  }, [context, bootstrapId, bootstrapIdentity, ready, setError, setKeys]);

  // Bootstrap: storage context first, then the mode-appropriate list. The
  // prove-then-reveal rule applies when the context fell back to legacy:
  // allow the legacy UI only after a successful list proves the fallback,
  // so a context401 on a hashed instance cannot unlock mutations or the
  // Default provision POST. No error leaks beyond the existing list-error copy.
  // biome-ignore lint/correctness/useExhaustiveDependencies: authStatus covered by bootstrapIdentity
  useEffect(() => {
    // A new identity starts clean: no prior one-time reveal or shown rows.
    setRevealed(null);
    setVisibleKeys(new Set());
    if (!ready) {
      // Settled but unusable auth (failed/expired status): stop loading and
      // surface a nonsecret error; no key request starts.
      if (authReady) {
        setLoading(false);
        setError("Could not load key permissions. Reload to try again.");
      }
      return;
    }
    setLoading(true);
    let cancelled = false;
    (async () => {
      try {
        const ctx = await loadKeyContext(authStatus);
        if (cancelled) return; // identity changed while the context was in flight
        let existing = await loadKeyList(ctx);
        if (cancelled) return;
        setContext(ctx);
        setBootstrapId(bootstrapIdentity);
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
        if (cancelled) return;
        setKeys(existing);
        setError(null);
      } catch (err) {
        // Error state before any context — capabilities stay closed.
        if (!cancelled) setError(err?.message || "Failed to load API keys.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, bootstrapIdentity, authReady, setError, setKeys]);

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
    if (creatingRef.current) return; // duplicate submit while a create is in flight
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

    // All validation above is synchronous: the guard is armed before the first await.
    creatingRef.current = true;
    setCreating(true);
    const startedFor = identityRef.current;
    try {
      const res = await fetch(scopedUrl("/api/keys"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await readJson(res);
      // Identity changed mid-flight: never reveal one user's new key to another.
      if (identityRef.current !== startedFor) return;
      if (!res.ok) {
        setCreateError(data?.error || "Failed to create API key.");
        return;
      }
      const keyId = data?.id || data?.key?.id;
      setRevealed({
        identity: startedFor,
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
    } finally {
      creatingRef.current = false;
      setCreating(false);
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
    creating,
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
    // Never render a reveal created under a different identity (the effect
    // also clears it; this covers the render before the effect runs).
    revealed: revealed && revealed.identity === bootstrapIdentity ? revealed : null,
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
