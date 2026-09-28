"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getStatusVariant as getConnectionStatusVariant } from "@/shared/utils/connectionStatus";
import CooldownTimer from "@/shared/components/CooldownTimer";
import PropTypes from "prop-types";
import {
  Card,
  Badge,
  Button,
  Modal,
  Select,
  Toggle,
  EditConnectionModal,
  ConfirmModal,
} from "@/shared/components";
import { ACCOUNT_STRATEGY_OPTIONS, OAUTH_STICKY_HINT } from "@/shared/constants/accountStrategies";

const INHERIT = "__inherit__";
const STRATEGY_SELECT_OPTIONS = [
  { value: INHERIT, label: "Inherit global setting" },
  ...ACCOUNT_STRATEGY_OPTIONS,
];

const OAUTH_SUBSCRIPTION_PROVIDERS = new Set([
  "claude",
  "codex",
  "github",
  "gemini-cli",
  "antigravity",
  "kiro",
  "cursor",
]);

const isOAuthSubscription = (providerId, isOAuth) =>
  isOAuth === true || OAUTH_SUBSCRIPTION_PROVIDERS.has(providerId);

const weightOf = (c) => {
  const w = c.effectiveWeight?.weight;
  return Number.isFinite(w) && w > 0 ? w : 0;
};

/** Approximate share (%) among active peers; all-zero falls back to equal split like routing. */
function activeShares(connections) {
  const active = connections.filter((c) => c.isActive !== false && c.effectiveWeight);
  const total = active.reduce((sum, c) => sum + weightOf(c), 0);
  return new Map(
    active.map((c) => [c.id, total > 0 ? (weightOf(c) / total) * 100 : 100 / active.length]),
  );
}

const round1 = (n) => String(Math.round(n * 10) / 10);

// ── ConnectionRow ──────────────────────────────────────────────
function ConnectionRow({
  connection,
  proxyPools,
  isOAuth,
  isFirst,
  isLast,
  isWeighted,
  sharePct,
  onMoveUp,
  onMoveDown,
  onToggleActive,
  onUpdateProxy,
  onEdit,
  onDelete,
}) {
  const [showProxyDropdown, setShowProxyDropdown] = useState(false);
  const [updatingProxy, setUpdatingProxy] = useState(false);
  const [isCooldown, setIsCooldown] = useState(false);
  const proxyDropdownRef = useRef(null);

  const proxyPoolMap = new Map((proxyPools || []).map((p) => [p.id, p]));
  const boundProxyPoolId = connection.providerSpecificData?.proxyPoolId || null;
  const boundProxyPool = boundProxyPoolId ? proxyPoolMap.get(boundProxyPoolId) : null;
  const hasLegacyProxy =
    connection.providerSpecificData?.connectionProxyEnabled === true &&
    !!connection.providerSpecificData?.connectionProxyUrl;
  const hasAnyProxy = !!boundProxyPoolId || hasLegacyProxy;

  const proxyDisplayText = boundProxyPool
    ? `Pool: ${boundProxyPool.name}`
    : boundProxyPoolId
      ? `Pool: ${boundProxyPoolId} (inactive/missing)`
      : hasLegacyProxy
        ? `Legacy: ${connection.providerSpecificData?.connectionProxyUrl}`
        : "";

  let maskedProxyUrl = "";
  const rawProxyUrl =
    boundProxyPool?.proxyUrl || connection.providerSpecificData?.connectionProxyUrl;
  if (rawProxyUrl) {
    try {
      const p = new URL(rawProxyUrl);
      maskedProxyUrl = `${p.protocol}//${p.hostname}${p.port ? `:${p.port}` : ""}`;
    } catch {
      maskedProxyUrl = rawProxyUrl;
    }
  }

  const noProxyText =
    boundProxyPool?.noProxy || connection.providerSpecificData?.connectionNoProxy || "";
  const proxyBadgeVariant =
    boundProxyPool?.isActive === true ? "success" : hasAnyProxy ? "error" : "default";

  const modelLockUntil =
    Object.entries(connection)
      .filter(([k]) => k.startsWith("modelLock_"))
      .map(([, v]) => v)
      .filter(Boolean)
      .sort()[0] || null;

  useEffect(() => {
    const check = () => {
      const until =
        Object.entries(connection)
          .filter(([k]) => k.startsWith("modelLock_"))
          .map(([, v]) => v)
          .filter((v) => v && new Date(v).getTime() > Date.now())
          .sort()[0] || null;
      setIsCooldown(!!until);
    };
    check();
    const t = modelLockUntil ? setInterval(check, 1000) : null;
    return () => {
      if (t) clearInterval(t);
    };
  }, [modelLockUntil]);

  useEffect(() => {
    if (!showProxyDropdown) return;
    const handler = (e) => {
      if (proxyDropdownRef.current && !proxyDropdownRef.current.contains(e.target))
        setShowProxyDropdown(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showProxyDropdown]);

  const effectiveStatus =
    connection.testStatus === "unavailable" && !isCooldown ? "active" : connection.testStatus;
  const ew = connection.effectiveWeight;
  const activeWeight = Number.isFinite(ew?.weight) && ew.weight > 0 ? ew.weight : null;
  const showWeight = isWeighted && ew && connection.isActive !== false;
  const belowFloor = showWeight && activeWeight === null;

  const getStatusVariant = () => getConnectionStatusVariant(connection.isActive, effectiveStatus);

  const displayName = isOAuth
    ? connection.name || connection.email || connection.displayName || "OAuth Account"
    : connection.name;

  const handleSelectProxy = async (poolId) => {
    setUpdatingProxy(true);
    try {
      await onUpdateProxy(poolId === "__none__" ? null : poolId);
    } finally {
      setUpdatingProxy(false);
      setShowProxyDropdown(false);
    }
  };

  return (
    <div
      className={`group flex flex-col gap-3 p-2 rounded-lg sm:flex-row sm:items-center sm:justify-between hover:bg-raised transition-colors ${connection.isActive === false ? "opacity-60" : ""}`}
    >
      <div className="flex w-full min-w-0 flex-1 items-start gap-3 sm:items-center">
        <div className="flex flex-col">
          <button
            onClick={onMoveUp}
            disabled={isFirst}
            className={`p-0.5 rounded ${isFirst ? "text-muted/30 cursor-not-allowed" : "hover:bg-raised text-muted hover:text-coral-ink"}`}
          >
            <span className="material-symbols-outlined text-sm">keyboard_arrow_up</span>
          </button>
          <button
            onClick={onMoveDown}
            disabled={isLast}
            className={`p-0.5 rounded ${isLast ? "text-muted/30 cursor-not-allowed" : "hover:bg-raised text-muted hover:text-coral-ink"}`}
          >
            <span className="material-symbols-outlined text-sm">keyboard_arrow_down</span>
          </button>
        </div>
        <span className="material-symbols-outlined text-base text-muted">
          {isOAuth ? "lock" : "key"}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{displayName}</p>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <Badge variant={getStatusVariant()} size="sm" dot>
              {connection.isActive === false ? "disabled" : effectiveStatus || "Unknown"}
            </Badge>
            {hasAnyProxy && (
              <Badge variant={proxyBadgeVariant} size="sm">
                Proxy
              </Badge>
            )}
            {isCooldown && connection.isActive !== false && (
              <CooldownTimer until={modelLockUntil} />
            )}
            {connection.lastError && connection.isActive !== false && (
              <span
                className="text-xs text-red-500 truncate max-w-[300px]"
                title={connection.lastError}
              >
                {connection.lastError}
              </span>
            )}
            <span className="text-xs text-muted">#{connection.priority}</span>
            {showWeight && (
              <>
                <Badge variant={belowFloor ? "warning" : "default"} size="sm">
                  {belowFloor
                    ? ew.baseSource === "manual" && ew.base === 0
                      ? "Weight 0 (fail-open if alone)"
                      : "Weight 0 (below floor)"
                    : `Weight ${round1(ew.weight)}`}
                </Badge>
                {Number.isFinite(sharePct) && <Badge size="sm">~{round1(sharePct)}% share</Badge>}
                <Badge size="sm">
                  {ew.baseSource || "default"} · {ew.headroomSource || "static"}
                </Badge>
              </>
            )}
          </div>
          {hasAnyProxy && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span
                className="text-[11px] text-muted truncate max-w-[420px]"
                title={proxyDisplayText}
              >
                {proxyDisplayText}
              </span>
              {maskedProxyUrl && (
                <code className="text-[10px] font-mono bg-raised px-1 py-0.5 rounded text-muted">
                  {maskedProxyUrl}
                </code>
              )}
              {noProxyText && (
                <span className="text-[11px] text-muted truncate max-w-[320px]" title={noProxyText}>
                  no_proxy: {noProxyText}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end">
        <div className="flex flex-wrap gap-1">
          {(proxyPools || []).length > 0 && (
            <div className="relative" ref={proxyDropdownRef}>
              <button
                onClick={() => setShowProxyDropdown((v) => !v)}
                className={`flex flex-col items-center px-2 py-1 rounded hover:bg-raised transition-colors ${hasAnyProxy ? "text-coral-ink" : "text-muted hover:text-coral-ink"}`}
                disabled={updatingProxy}
              >
                <span className="material-symbols-outlined text-[18px]">
                  {updatingProxy ? "progress_activity" : "lan"}
                </span>
                <span className="text-[10px] leading-tight">Proxy</span>
              </button>
              {showProxyDropdown && (
                <div className="absolute right-0 top-full mt-1 z-50 bg-panel border border-line rounded-lg shadow-lg py-1 min-w-[160px]">
                  <button
                    onClick={() => handleSelectProxy("__none__")}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-raised ${!boundProxyPoolId ? "text-coral-ink font-medium" : "text-text"}`}
                  >
                    None
                  </button>
                  {(proxyPools || []).map((pool) => (
                    <button
                      key={pool.id}
                      onClick={() => handleSelectProxy(pool.id)}
                      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-raised ${boundProxyPoolId === pool.id ? "text-coral-ink font-medium" : "text-text"}`}
                    >
                      {pool.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            onClick={onEdit}
            className="flex flex-col items-center px-2 py-1 rounded hover:bg-raised text-muted hover:text-coral-ink"
          >
            <span className="material-symbols-outlined text-[18px]">edit</span>
            <span className="text-[10px] leading-tight">Edit</span>
          </button>
          <button
            onClick={onDelete}
            className="flex flex-col items-center px-2 py-1 rounded hover:bg-red-500/10 text-red-500"
          >
            <span className="material-symbols-outlined text-[18px]">delete</span>
            <span className="text-[10px] leading-tight">Delete</span>
          </button>
        </div>
        <Toggle
          size="sm"
          checked={connection.isActive ?? true}
          onChange={onToggleActive}
          title={(connection.isActive ?? true) ? "Disable" : "Enable"}
        />
      </div>
    </div>
  );
}

ConnectionRow.propTypes = {
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    displayName: PropTypes.string,
    testStatus: PropTypes.string,
    isActive: PropTypes.bool,
    lastError: PropTypes.string,
    priority: PropTypes.number,
  }).isRequired,
  proxyPools: PropTypes.array,
  isOAuth: PropTypes.bool.isRequired,
  isFirst: PropTypes.bool.isRequired,
  isLast: PropTypes.bool.isRequired,
  isWeighted: PropTypes.bool,
  sharePct: PropTypes.number,
  onMoveUp: PropTypes.func.isRequired,
  onMoveDown: PropTypes.func.isRequired,
  onToggleActive: PropTypes.func.isRequired,
  onUpdateProxy: PropTypes.func,
  onEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
};

// ── AddApiKeyModal ─────────────────────────────────────────────
function AddApiKeyModal({ isOpen, provider, providerName, proxyPools, error, onSave, onClose }) {
  const NONE = "__none__";
  const [formData, setFormData] = useState({
    name: "",
    apiKey: "",
    priority: 1,
    proxyPoolId: NONE,
  });
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [saving, setSaving] = useState(false);
  // Bumped whenever the key changes; an in-flight check from an older key is discarded.
  const validationSeq = useRef(0);

  // The modal stays mounted: start every open from a blank form so a reused
  // name/key can never overwrite an existing connection.
  useEffect(() => {
    if (isOpen) {
      setFormData({ name: "", apiKey: "", priority: 1, proxyPoolId: NONE });
      setValidationResult(null);
    }
  }, [isOpen]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: dep is the validation input by design
  useEffect(() => {
    validationSeq.current += 1;
    setValidationResult(null);
  }, [formData.apiKey]);

  const handleValidate = async () => {
    const seq = validationSeq.current;
    setValidating(true);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: formData.apiKey }),
      });
      const data = await res.json();
      if (validationSeq.current === seq) setValidationResult(data.valid ? "success" : "failed");
    } catch {
      if (validationSeq.current === seq) setValidationResult("failed");
    } finally {
      setValidating(false);
    }
  };

  const handleSubmit = async () => {
    if (!provider || !formData.apiKey) return;
    setSaving(true);
    try {
      const seq = validationSeq.current;
      let isValid = false;
      try {
        setValidating(true);
        setValidationResult(null);
        const res = await fetch("/api/providers/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, apiKey: formData.apiKey }),
        });
        const data = await res.json();
        isValid = !!data.valid;
        if (validationSeq.current === seq) setValidationResult(isValid ? "success" : "failed");
      } catch {
        if (validationSeq.current === seq) setValidationResult("failed");
      } finally {
        setValidating(false);
      }
      await onSave({
        name: formData.name,
        apiKey: formData.apiKey,
        priority: formData.priority,
        proxyPoolId: formData.proxyPoolId === NONE ? null : formData.proxyPoolId,
        testStatus: isValid ? "active" : "unknown",
      });
    } finally {
      setSaving(false);
    }
  };

  if (!provider) return null;

  return (
    <Modal isOpen={isOpen} title={`Add ${providerName || provider} API Key`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div>
          <label className="text-xs text-muted mb-1 block">Name</label>
          <input
            className="w-full px-3 py-2 text-sm border border-line rounded-lg bg-raised focus:outline-none focus:border-coral"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder="Production Key"
          />
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-xs text-muted mb-1 block">API Key</label>
            <input
              type="password"
              className="w-full px-3 py-2 text-sm border border-line rounded-lg bg-raised focus:outline-none focus:border-coral"
              value={formData.apiKey}
              onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
            />
          </div>
          <div className="pt-6">
            <Button
              onClick={handleValidate}
              disabled={!formData.apiKey || validating || saving}
              variant="secondary"
            >
              {validating ? "Checking..." : "Check"}
            </Button>
          </div>
        </div>
        {validationResult && (
          <Badge variant={validationResult === "success" ? "success" : "error"}>
            {validationResult === "success" ? "Valid" : "Invalid"}
          </Badge>
        )}
        {error && <p className="text-xs text-red-500 break-words">{error}</p>}
        <div>
          <label className="text-xs text-muted mb-1 block">Priority</label>
          <input
            type="number"
            className="w-full px-3 py-2 text-sm border border-line rounded-lg bg-raised focus:outline-none focus:border-coral"
            value={formData.priority}
            onChange={(e) =>
              setFormData({ ...formData, priority: Number.parseInt(e.target.value, 10) || 1 })
            }
          />
        </div>
        <Select
          label="Proxy Pool"
          value={formData.proxyPoolId}
          onChange={(e) => setFormData({ ...formData, proxyPoolId: e.target.value })}
          options={[
            { value: NONE, label: "None" },
            ...(proxyPools || []).map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
        <div className="flex gap-2">
          <Button
            onClick={handleSubmit}
            fullWidth
            disabled={!formData.name || !formData.apiKey || saving}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

AddApiKeyModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  provider: PropTypes.string,
  providerName: PropTypes.string,
  proxyPools: PropTypes.array,
  error: PropTypes.string,
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};

// ── ConnectionsCard ────────────────────────────────────────────
// Self-contained card: fetches, displays and manages all connections for a provider.
export default function ConnectionsCard({ providerId, isOAuth }) {
  const [connections, setConnections] = useState([]);
  const [proxyPools, setProxyPools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addError, setAddError] = useState("");
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [providerStrategy, setProviderStrategy] = useState(null);
  const [globalStrategy, setGlobalStrategy] = useState("fill-first");
  const [providerStickyLimit, setProviderStickyLimit] = useState("");
  const savedStickyLimit = useRef("");
  const [globalStickyLimit, setGlobalStickyLimit] = useState(3);
  const [strategySaving, setStrategySaving] = useState(false);
  const [strategyError, setStrategyError] = useState("");
  const [confirmState, setConfirmState] = useState(null);

  const fetch_ = useCallback(async () => {
    try {
      const [connRes, proxyRes, settingsRes] = await Promise.all([
        fetch("/api/providers", { cache: "no-store" }),
        fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }),
        fetch("/api/settings", { cache: "no-store" }),
      ]);
      const connData = await connRes.json();
      const proxyData = await proxyRes.json();
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      if (connRes.ok)
        setConnections((connData.connections || []).filter((c) => c.provider === providerId));
      if (proxyRes.ok) setProxyPools(proxyData.proxyPools || []);
      const override = settingsData.providerStrategies?.[providerId] || {};
      setProviderStrategy(override.fallbackStrategy || null);
      setGlobalStrategy(settingsData.fallbackStrategy || "fill-first");
      setGlobalStickyLimit(settingsData.stickyRoundRobinLimit ?? 3);
      const stickyLimit =
        override.stickyRoundRobinLimit != null ? String(override.stickyRoundRobinLimit) : "";
      savedStickyLimit.current = stickyLimit;
      setProviderStickyLimit(stickyLimit);
    } catch (e) {
      console.log("ConnectionsCard fetch error:", e);
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => {
    fetch_();
  }, [fetch_]);

  // Preserve NoAuthProxyCard/other keys (rotateStrategy, proxyPoolId); only touch
  // fallbackStrategy/stickyRoundRobinLimit.
  const saveStrategy = async (strategy, stickyLimit) => {
    const persistSticky =
      strategy === "round-robin" || strategy === "weighted" || strategy === null;
    if (persistSticky && stickyLimit !== "") {
      const n = Number(stickyLimit);
      if (!/^\d+$/.test(stickyLimit) || !Number.isInteger(n) || n < 1 || n > 100) {
        setStrategyError("Sticky limit must be an integer from 1 to 100.");
        return false;
      }
    }
    setStrategySaving(true);
    setStrategyError("");
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load settings");
      const data = await res.json();
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };
      if (strategy) override.fallbackStrategy = strategy;
      else delete override.fallbackStrategy;
      // Inherit (null) keeps an explicit sticky so it can be edited/cleared without
      // forcing a fallbackStrategy override.
      if (persistSticky) {
        if (stickyLimit !== "") override.stickyRoundRobinLimit = Number(stickyLimit);
        else if (strategy === "round-robin") override.stickyRoundRobinLimit = 1;
        // Blank weighted/inherit clears the key so routing reverts to the global/OAuth
        // default; blank round-robin keeps its historical per-provider default of 1.
        else delete override.stickyRoundRobinLimit;
      } else {
        delete override.stickyRoundRobinLimit;
      }
      const updated = { ...current };
      // ponytail: key-count decides delete vs merge (not value equality). A blank sticky
      // keeps the routing backend on its global/OAuth default; an explicit 0/"" in stored
      // settings would instead fail backend validation. Revisit only if backend starts
      // treating "absent override key" differently from "explicit blank".
      if (override.fallbackStrategy == null && override.stickyRoundRobinLimit == null) {
        if (current[providerId]) {
          const rest = { ...current[providerId] };
          delete rest.fallbackStrategy;
          delete rest.stickyRoundRobinLimit;
          if (Object.keys(rest).length === 0) delete updated[providerId];
          else updated[providerId] = rest;
        }
      } else {
        updated[providerId] = override;
      }
      const patchRes = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
      if (!patchRes.ok) {
        const err = await patchRes.json().catch(() => ({}));
        setStrategyError(err.error || "Failed to save strategy");
        return false;
      }
      savedStickyLimit.current =
        override.stickyRoundRobinLimit != null ? String(override.stickyRoundRobinLimit) : "";
      setProviderStickyLimit(savedStickyLimit.current);
      return true;
    } catch (e) {
      console.log("saveStrategy error:", e);
      setStrategyError("Failed to save strategy");
      return false;
    } finally {
      setStrategySaving(false);
    }
  };

  const handleSwapPriority = async (i1, i2) => {
    const next = [...connections];
    [next[i1], next[i2]] = [next[i2], next[i1]];
    setConnections(next);
    try {
      await Promise.all([
        fetch(`/api/providers/${next[i1].id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ priority: i1 }),
        }),
        fetch(`/api/providers/${next[i2].id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ priority: i2 }),
        }),
      ]);
    } catch {
      await fetch_();
    }
  };

  const handleDelete = async (id) => {
    setConfirmState({
      title: "Delete Connection",
      message: "Delete this connection?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
          if (res.ok) setConnections((prev) => prev.filter((c) => c.id !== id));
        } catch (e) {
          console.log("delete error:", e);
        }
      },
    });
  };

  const handleToggleActive = async (id, isActive) => {
    try {
      const res = await fetch(`/api/providers/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (res.ok) setConnections((prev) => prev.map((c) => (c.id === id ? { ...c, isActive } : c)));
    } catch (e) {
      console.log("toggle error:", e);
    }
  };

  const handleUpdateProxy = async (connId, proxyPoolId) => {
    try {
      const res = await fetch(`/api/providers/${connId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyPoolId: proxyPoolId || null }),
      });
      if (res.ok)
        setConnections((prev) =>
          prev.map((c) =>
            c.id === connId
              ? {
                  ...c,
                  providerSpecificData: {
                    ...c.providerSpecificData,
                    proxyPoolId: proxyPoolId || null,
                  },
                }
              : c,
          ),
        );
    } catch (e) {
      console.log("proxy error:", e);
    }
  };

  const handleSaveApiKey = async (formData) => {
    setAddError("");
    try {
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, ...formData }),
      });
      if (res.ok) {
        await fetch_();
        setShowAddModal(false);
        return;
      }
      const data = await res.json().catch(() => null);
      setAddError(data?.error || "Failed to save connection");
    } catch (e) {
      console.log("save apikey error:", e);
      setAddError("Failed to save connection");
    }
  };

  const handleUpdateConnection = async (formData) => {
    try {
      const res = await fetch(`/api/providers/${selectedConnection.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return data.error || "Failed to save connection";
      }
      await fetch_();
      setShowEditModal(false);
      return null;
    } catch (e) {
      console.log("update connection error:", e);
      return "Failed to save connection";
    }
  };

  const effectiveStrategy = providerStrategy || globalStrategy;
  const isWeighted = effectiveStrategy === "weighted";
  const subscription = isOAuthSubscription(providerId, isOAuth);
  const inheriting = providerStrategy == null;
  // Inheriting still shows an editable input when the global strategy uses sticky, or
  // when an orphan per-provider sticky exists, so it can be edited or cleared.
  const showSticky =
    effectiveStrategy === "round-robin" ||
    isWeighted ||
    (inheriting && savedStickyLimit.current !== "");
  const stickyInputId = `sticky-${providerId}`;
  // Placeholder mirrors routing default when override blank: weighted uses the global
  // limit for OAuth subscriptions, 1 otherwise; explicit round-robin defaults to 1,
  // inherited round-robin uses the global limit.
  const stickyPlaceholder = isWeighted
    ? subscription
      ? String(globalStickyLimit)
      : "1"
    : inheriting
      ? String(globalStickyLimit)
      : "1";
  const shares = isWeighted ? activeShares(connections) : new Map();
  const weightedHint = isWeighted && subscription ? OAUTH_STICKY_HINT : "";
  // Weighted routing honors an explicit provider sticky even when the strategy itself
  // is inherited (resolveWeightedStickyLimit), so warn on inherited sticky 1 too.
  const effectiveSticky =
    providerStickyLimit !== ""
      ? Number(providerStickyLimit)
      : subscription
        ? Number(globalStickyLimit)
        : 1;
  const stickyOneWarning = isWeighted && subscription && effectiveSticky === 1;

  const handleStrategyChange = (value) => {
    const strategy = value === INHERIT ? null : value;
    const prevStrategy = providerStrategy;
    setProviderStrategy(strategy);
    // Pass the uncommitted draft; saveStrategy validates it and reverts on failure.
    saveStrategy(strategy, providerStickyLimit).then((saved) => {
      if (!saved) setProviderStrategy(prevStrategy);
    });
  };

  const commitStickyLimit = (value) => {
    if (strategySaving || (value === savedStickyLimit.current && !strategyError)) return;
    saveStrategy(providerStrategy, value);
  };

  if (loading)
    return (
      <Card>
        <div className="h-20 animate-pulse bg-raised rounded-lg" />
      </Card>
    );

  return (
    <>
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
          <h2 className="text-lg font-semibold">Connections</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="Account strategy for this provider"
              value={providerStrategy || INHERIT}
              onChange={(e) => handleStrategyChange(e.target.value)}
              disabled={strategySaving}
              options={STRATEGY_SELECT_OPTIONS}
              selectClassName="py-1.5 text-xs sm:text-xs"
            />
            {showSticky && (
              <div className="flex flex-wrap items-center gap-1.5">
                <label htmlFor={stickyInputId} className="text-xs text-muted">
                  Sticky:
                </label>
                <input
                  id={stickyInputId}
                  type="number"
                  min={1}
                  max={100}
                  value={providerStickyLimit}
                  placeholder={stickyPlaceholder}
                  title={
                    inheriting
                      ? "Blank uses the global sticky limit; a value here overrides it for this provider only"
                      : undefined
                  }
                  onChange={(e) => setProviderStickyLimit(e.target.value)}
                  onBlur={(e) => commitStickyLimit(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    else if (e.key === "Escape") {
                      e.preventDefault(); // keep the dialog open; Esc resets the field
                      setProviderStickyLimit(savedStickyLimit.current);
                    }
                  }}
                  className="w-16 px-2 py-1 text-xs border border-line rounded-md bg-raised focus:outline-none focus:border-coral"
                />
                {inheriting && savedStickyLimit.current !== "" && (
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => saveStrategy(null, "")}
                    disabled={strategySaving}
                    className="text-xs text-muted underline-offset-2 hover:text-coral-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Clear override
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {(strategyError || weightedHint) && (
          <div className="mb-4 flex flex-col gap-1">
            {strategyError && (
              <p className="text-xs text-red-500" role="alert">
                {strategyError}
              </p>
            )}
            {weightedHint && <p className="text-xs text-muted">{weightedHint}</p>}
            {stickyOneWarning && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Sticky 1 switches subscription accounts every request — may trip anti-abuse flags.
                Prefer 3 or higher.
              </p>
            )}
          </div>
        )}

        {connections.length === 0 ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted">No connections yet</p>
            <Button size="sm" icon="add" onClick={() => setShowAddModal(true)}>
              Add Connection
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-col divide-y divide-black/[0.03] dark:divide-white/[0.03] max-h-[500px] overflow-y-auto pr-1">
              {connections.map((conn, idx) => (
                <ConnectionRow
                  key={conn.id}
                  connection={conn}
                  proxyPools={proxyPools}
                  isOAuth={isOAuth}
                  isFirst={idx === 0}
                  isLast={idx === connections.length - 1}
                  isWeighted={isWeighted}
                  sharePct={shares.get(conn.id)}
                  onMoveUp={() => handleSwapPriority(idx, idx - 1)}
                  onMoveDown={() => handleSwapPriority(idx, idx + 1)}
                  onToggleActive={(isActive) => handleToggleActive(conn.id, isActive)}
                  onUpdateProxy={(poolId) => handleUpdateProxy(conn.id, poolId)}
                  onEdit={() => {
                    setSelectedConnection(conn);
                    setShowEditModal(true);
                  }}
                  onDelete={() => handleDelete(conn.id)}
                />
              ))}
            </div>
            {isWeighted && shares.size > 0 && (
              <p className="mt-2 text-xs text-muted">
                Share is approximate: computed across active accounts from current quota data;
                model-specific windows and temporary locks are not reflected.
              </p>
            )}
            <div className="mt-4 flex justify-stretch sm:justify-start">
              <Button size="sm" icon="add" onClick={() => setShowAddModal(true)}>
                Add
              </Button>
            </div>
          </>
        )}
      </Card>

      <AddApiKeyModal
        isOpen={showAddModal}
        provider={providerId}
        proxyPools={proxyPools}
        error={addError}
        onSave={handleSaveApiKey}
        onClose={() => {
          setAddError("");
          setShowAddModal(false);
        }}
      />
      <EditConnectionModal
        isOpen={showEditModal}
        connection={selectedConnection}
        proxyPools={proxyPools}
        onSave={handleUpdateConnection}
        onClose={() => setShowEditModal(false)}
      />

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </>
  );
}

ConnectionsCard.propTypes = {
  providerId: PropTypes.string.isRequired,
  isOAuth: PropTypes.bool,
};
