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

/** Parse a JSON body without throwing (empty/HTML error bodies → null). */
const readJson = (res) => res.json().catch(() => null);

/**
 * Pristine/local fallback when `/api/keys/context` is unavailable (401): the
 * legacy single-admin key flow applies exactly as before. Capabilities are
 * not client-guessed in hashed mode — a 401 context means legacy, every
 * hashed-storage failure surfaces as an error instead of this fallback.
 */
const LEGACY_CONTEXT = Object.freeze({
  storage: "legacy",
  workspaceId: null,
  canCreate: true,
  canManage: true,
  canCreateService: false,
});

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
// A failed context never unlocks legacy affordances. Only the pristine-off
// unauthenticated context401 may try the existing legacy API; hashed APIs
// still reject that request, so list errors never lead to provisioning.
export async function loadKeyContext() {
  const res = await fetch("/api/keys/context", { cache: "no-store" });
  if (res.status === 401) return LEGACY_CONTEXT;
  const data = await readJson(res);
  if (!res.ok) throw new Error(data?.error || "Failed to load key permissions.");
  if (
    !data ||
    !["legacy", "hashed"].includes(data.storage) ||
    (data.storage === "hashed" && !data.workspaceId)
  ) {
    throw new Error("Invalid key context response.");
  }
  if (data.storage === "legacy") return LEGACY_CONTEXT;
  return {
    storage: data.storage,
    workspaceId: data.workspaceId,
    canCreate: data.canCreate === true,
    canManage: data.canManage === true,
    canCreateService: data.canCreateService === true,
    // Spec214 durable flag (hashed only): the single notice authority.
    // Absent means unacknowledged; never localStorage.
    migrationAcknowledged: data.migrationAcknowledged === true,
  };
}

/**
 * Manager-only durable dismissal: exact spec214 body, workspace-scoped URL,
 * nonsecret success only. Never optimistic — the caller hides the notice only
 * on success; failures keep it plus the (nonsecret) server error literal.
 * @param {object} context Current hashed key context.
 * @returns {Promise<void>} resolves only on confirmed success.
 */
export async function acknowledgeMigration(context) {
  if (context?.storage !== "hashed" || context.canManage !== true || !context.workspaceId) {
    throw new Error("Only workspace managers can dismiss this notice.");
  }
  const res = await fetch(`/api/keys?workspaceId=${encodeURIComponent(context.workspaceId)}`, {
    method: "PATCH",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ acknowledgeMigration: true }),
  });
  const data = await readJson(res);
  if (
    !res.ok ||
    data?.success !== true ||
    data?.migrationAcknowledged !== true ||
    data?.storage !== "hashed"
  ) {
    throw new Error("Could not dismiss the notice. Try again.");
  }
}

export async function loadKeyList(context) {
  // Viewers (no create, no manage) have nothing to list and the server 403s
  // them: skip the call entirely (no privilege probing). Members with create
  // access list their own user keys; managers list every workspace key.
  if (context.storage === "hashed" && !context.canManage && !context.canCreate) return [];
  const url =
    context.storage === "hashed"
      ? `/api/keys?workspaceId=${encodeURIComponent(context.workspaceId)}`
      : "/api/keys";
  const res = await fetch(url, { cache: "no-store" });
  const data = await readJson(res);
  // A stale context or a mid-flight role change answers 403: nothing this
  // principal may see — render the empty state instead of an error.
  if (context.storage === "hashed" && res.status === 403) return [];
  if (!res.ok) throw new Error(data?.error || "Failed to load API keys.");
  // Never accept hashed metadata through the unauthenticated legacy fallback.
  if (context.storage !== "hashed" && data?.storage === "hashed") {
    throw new Error("Key permissions changed. Reload this page.");
  }
  if (!Array.isArray(data?.keys)) throw new Error("Invalid key list response.");
  return data.keys;
}

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

    // Hashed mode: type / model + combo scope / expiry ride along; the
    // member-safe type is forced server-side, the client hides Service unless allowed.
    let body = { name };
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
      setRevealed({
        id: data?.id || data?.key?.id,
        name: data?.name || name,
        plain: typeof data?.key === "string" ? data.key : data?.plain || "",
        prefix: typeof data?.metadata?.prefix === "string" ? data.metadata.prefix : null,
      });
      setNewKeyNameState("");
      resetCreateForm();
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

  const dismissRevealed = () => setRevealed(null);

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
