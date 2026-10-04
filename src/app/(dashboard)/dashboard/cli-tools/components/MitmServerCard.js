"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Badge, Input, Modal } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { markLocalOnly } from "@/store/cliAccessStore";
import { isLocalOnlyResponse } from "@/shared/utils/localOnly";
import { readMitmResponse } from "./mitmToolActions";
import { buildMitmStartBody, bindRemoteKey } from "./mitmStartRequest";
import { ACTIVE } from "@/shared/brand";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";

/**
 * Shared MITM infrastructure card — manages SSL cert + server start/stop.
 * DNS per-tool is handled separately in MitmToolCard.
 *
 * YAN-363 hashed mode: the raw bearer is custody of the server only (local
 * internal credential, env/file startup sources, or a transient manual remote
 * binding held in server memory). The browser never sends stored raws,
 * presets, defaults, or prefixes — local starts omit apiKey entirely; a
 * remote destination accepts one explicitly pasted transient key only when
 * the status says it needs one (`needsCredential` / no configured source).
 */
export default function MitmServerCard({ apiKeys, cloudEnabled, onStatusChange }) {
  const [status, setStatus] = useState(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [sudoPassword, setSudoPassword] = useState("");
  // Legacy storage: selected key exactly as before (hashed uses remoteKey).
  const [selectedApiKey, setSelectedApiKey] = useState(() => apiKeys?.[0]?.key || "");
  // Transient remote-destination key only, bound at paste time to the exact
  // destination showing in the URL input. Any destination change invalidates
  // it: the server's manual binding is per-destination, so a paste retained
  // across a URL change would start the wrong host. Never persisted.
  const [remoteKey, setRemoteKey] = useState("");
  const [pendingAction, setPendingAction] = useState(null);
  const [modalError, setModalError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [mitmRouterBaseUrl, setMitmRouterBaseUrl] = useState(DEFAULT_MITM_ROUTER_BASE);
  const [port443Conflict, setPort443Conflict] = useState(null);

  const serverIsWindows = status?.isWin === true;
  const canRunWithoutPassword =
    serverIsWindows || status?.hasCachedPassword || status?.needsSudoPassword === false;
  const isAdmin = status?.isAdmin !== false;
  // No privilege: not admin/root AND (Win OR no cached sudo password)
  const noPrivilege =
    !isAdmin &&
    (serverIsWindows || (!status?.hasCachedPassword && status?.needsSudoPassword !== false));

  const notifyError = useNotificationStore((state) => state.error);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/cli-tools/antigravity-mitm");
      if (await isLocalOnlyResponse(res)) return markLocalOnly();
      const data = await readMitmResponse(res, "Failed to load MITM status");
      setStatus(data);
      setStatusFailed(false);
      if (data.mitmRouterBaseUrl) {
        setMitmRouterBaseUrl(data.mitmRouterBaseUrl);
      }
      onStatusChange?.(data);
    } catch (error) {
      // Keep the card visible: stale controls are better than a blank page,
      // but the failed refresh must say so. A failed status says nothing
      // about storage mode, so never fall back to legacy key behavior.
      setStatusFailed(true);
      notifyError(`Couldn't load MITM server status: ${error.message || "Network error"}.`);
    }
  }, [notifyError, onStatusChange]);

  // Authoritative hashed signal from the actual GET contract, never a guess:
  // `storage: "hashed"` plus a non-legacy credential source. Any other shape
  // (absent fields, "legacy", or an unloaded/failed status) renders the
  // legacy key row — but the Start button stays disabled until the server has
  // explicitly reported, so no default fallback is ever sent unproven.
  const hashed = status?.storage === "hashed" && status?.credentialSource !== "legacy";
  // Remote destinations need an explicit key only when the server has nothing
  // configured for them: `needsCredential`, or no configured source at all.
  const remoteNeedsKey =
    hashed && (status.needsCredential === true || !status.credentialConfigured);
  // Any hashed destination edit invalidates the pending paste (whatever the
  // previous source): the server's manual binding lives for one destination
  // only, so the operator re-pastes for the new target.
  const onMitmRouterBaseUrlChange = (next) => {
    setMitmRouterBaseUrl(next);
    if (hashed && remoteKey) setRemoteKey("");
  };

  useEffect(() => {
    queueMicrotask(() => {
      fetchStatus();
    });
  }, [fetchStatus]);

  const handleAction = (action) => {
    setActionError(null);
    // Wait for status to load before deciding whether to show sudo modal
    if (!status) return;
    if (canRunWithoutPassword) {
      doAction(action, "");
    } else {
      setPendingAction(action);
      setShowPasswordModal(true);
      setModalError(null);
    }
  };

  const doAction = async (action, password, forceKillPort443 = false) => {
    setLoading(true);
    setActionError(null);
    // The transient key survives only the explicit port-443 "Kill & start"
    // retry; every other outcome (409, other errors, network) clears it.
    let retainKeyForRetry = false;
    try {
      let res;
      if (action === "trust-cert") {
        res = await fetch("/api/cli-tools/antigravity-mitm", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "trust-cert", sudoPassword: password }),
        });
      } else if (action === "start") {
        // Hashed: local destinations never carry a browser key (the server's
        // internal credential owns custody). A pasted remote key travels only
        // when the status needs one AND it was pasted for this exact target
        // (buildMitmStartBody validates the binding) — never a retained,
        // default, prefix, or ref substitute. Legacy keeps the
        // selected-or-default key exactly as before.
        const targetUrl = mitmRouterBaseUrl.trim() || DEFAULT_MITM_ROUTER_BASE;
        const body = buildMitmStartBody({
          hashed,
          status: hashed
            ? {
                needsCredential: status?.needsCredential,
                credentialConfigured: status?.credentialConfigured,
              }
            : null,
          sudoPassword: password,
          mitmRouterBaseUrl: targetUrl,
          forceKillPort443,
          remoteKeyBinding: hashed ? bindRemoteKey(remoteKey, targetUrl) : null,
          legacyKey: !hashed ? selectedApiKey : null,
          legacyFallback: !hashed
            ? {
                firstKey: apiKeys?.length > 0 ? apiKeys[0].key : null,
                defaultKey: !cloudEnabled ? ACTIVE.defaultApiKey : null,
              }
            : null,
        });
        res = await fetch("/api/cli-tools/antigravity-mitm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        res = await fetch("/api/cli-tools/antigravity-mitm", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sudoPassword: password }),
        });
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.code === "PORT_443_BUSY" && data.portOwner) {
          setShowPasswordModal(false);
          // Keep the operator's sudo password AND the pasted key for the
          // explicit "Kill & start" retry; every other terminal outcome below
          // clears the key in finally (409/4xx/5xx/network included).
          retainKeyForRetry = true;
          setPort443Conflict({ owner: data.portOwner, password });
          return;
        }
        if (action === "start" && data.code === "MITM_STARTUP_SOURCE_LOCKED") {
          // Typed key against a matching startup source: the server keeps the
          // configured source and rejects (static guidance only) — no source
          // change, no typed-key win.
          setActionError(
            data.error ||
              "MITM remote credential uses the operator startup source. Omit apiKey to use that source, or clear the startup source and restart the parent to use a typed credential.",
          );
          return;
        }
        setActionError(data.error || `Failed to ${action} MITM server`);
        return;
      }
      setShowPasswordModal(false);
      setSudoPassword("");
      setPort443Conflict(null);
      await fetchStatus();
    } catch (e) {
      setActionError(e.message || "Network error");
    } finally {
      // The pasted key clears on every outcome: 409/guidance retries must
      // re-paste (intended retry copy, not the secret), and the port-443
      // modal's retry already captured its own password ref without keys.
      if (!retainKeyForRetry) setRemoteKey("");
      setLoading(false);
      setPendingAction(null);
    }
  };

  const handleKillAndStart = () => {
    const pwd = port443Conflict?.password || "";
    doAction("start", pwd, true);
  };

  // Start is impossible to reason about without a fresh status: unknown or
  // failed storage means the card must not guess legacy defaults. The Start
  // button stays disabled whenever the status is unknown or its refresh
  // failed (see disabled/title and the explicit notice below) — only a
  // confirmed snapshot may drive a start.

  const handleConfirmPassword = () => {
    if (!sudoPassword.trim()) {
      setModalError("Sudo password is required");
      return;
    }
    doAction(pendingAction, sudoPassword);
  };

  const isRunning = status?.running;

  // Human label for the actual server-reported credential source. Values from
  // the GET contract only; no invented sources, no paths, no raws. A typed
  // key against a matching startup source is rejected with
  // MITM_STARTUP_SOURCE_LOCKED (static guidance) — the input is absent there,
  // so nothing changes, but a paste attempt still lands here.
  const SOURCE_LABEL = {
    internal: "Managed internally — the key never leaves this machine",
    manual: "Pasted for this destination — held in memory only",
    env: "Set by the operator via environment",
    file: "Set by the operator via file",
    legacy: "Legacy key storage",
    none: "None",
  };
  const sourceLabel = hashed ? (SOURCE_LABEL[status?.credentialSource] ?? "None") : null;

  return (
    <>
      <Card padding="sm" className="border-coral/20 bg-coral-bg">
        <div className="flex flex-col gap-3">
          {/* Header */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span
                className="material-symbols-outlined text-coral-ink text-[20px]"
                aria-hidden="true"
              >
                security
              </span>
              <span className="font-semibold text-sm text-text">MITM server</span>
              {isRunning ? (
                <Badge variant="success" size="sm">
                  Running
                </Badge>
              ) : (
                <Badge variant="default" size="sm">
                  Stopped
                </Badge>
              )}
            </div>
            <div
              className="flex flex-wrap items-center gap-1 text-xs text-muted"
              data-i18n-skip="true"
            >
              {[
                { label: "Cert", ok: status?.certExists },
                { label: "Trusted", ok: status?.certTrusted },
                { label: "Server", ok: isRunning },
              ].map(({ label, ok }) => (
                <span
                  key={label}
                  className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded ${ok ? "text-green-600" : "text-muted"}`}
                >
                  <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
                    {ok ? "check_circle" : "cancel"}
                  </span>
                  {label}
                </span>
              ))}
            </div>
          </div>

          {/* Purpose & How it works */}
          <div className="px-2 py-2 rounded-lg bg-panel/50 border border-line/50 flex flex-col gap-2">
            <p className="text-[11px] text-muted leading-relaxed">
              <span className="font-medium text-text">Purpose:</span>{" "}
              {`Use Antigravity IDE & GitHub Copilot → with ANY provider/model from ${ACTIVE.name}`}
            </p>
            <p className="text-[11px] text-muted leading-relaxed">
              <span className="font-medium text-text">How it works:</span>{" "}
              {`Antigravity/Copilot IDE request → DNS redirect to localhost:443 → MITM proxy intercepts → ${ACTIVE.name} → response to Antigravity/Copilot`}
            </p>
          </div>

          {/* Base URL + API key — same row pattern as Claude Code / cli-tools */}
          <div className="flex flex-col gap-2">
            <div className="grid gap-1 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
              <span className="text-xs font-semibold text-text sm:text-right sm:text-sm">
                {`${ACTIVE.name} base URL`}
              </span>
              <span
                className="material-symbols-outlined hidden text-muted text-[14px] sm:inline"
                aria-hidden="true"
              >
                arrow_forward
              </span>
              <input
                type="text"
                value={mitmRouterBaseUrl}
                onChange={(e) => onMitmRouterBaseUrlChange(e.target.value)}
                placeholder={DEFAULT_MITM_ROUTER_BASE}
                disabled={isRunning}
                className="flex-1 min-w-0 px-2 py-1.5 bg-panel rounded border border-line text-xs text-text focus:outline-none focus:ring-1 focus:ring-coral/50 disabled:opacity-50"
              />
            </div>
            {!isRunning &&
              (hashed ? (
                <div className="grid gap-1 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text sm:text-right sm:text-sm">
                    API key
                  </span>
                  <span
                    className="material-symbols-outlined hidden text-muted text-[14px] sm:inline"
                    aria-hidden="true"
                  >
                    arrow_forward
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-xs text-muted" role="status">
                      Credential: {sourceLabel}
                      {status?.needsCredential === true &&
                        (remoteNeedsKey ? " — paste one to start" : " — will be checked on start")}
                      .
                      {status?.credentialSource === "env" || status?.credentialSource === "file"
                        ? " A typed key here can't override it."
                        : ""}
                      {status?.credentialSource === "internal" ? " Local starts need no key." : ""}
                    </span>
                    {remoteNeedsKey && (
                      <input
                        type="password"
                        value={remoteKey}
                        onChange={(e) => setRemoteKey(e.target.value)}
                        placeholder="Paste destination key (kept for this start only)"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label="Paste destination key"
                        className="flex-1 min-w-0 px-2 py-1.5 bg-panel rounded border border-line text-xs text-text focus:outline-none focus:ring-1 focus:ring-coral/50"
                      />
                    )}
                  </div>
                </div>
              ) : (
                <div className="grid gap-1 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text sm:text-right sm:text-sm">
                    API key
                  </span>
                  <span
                    className="material-symbols-outlined hidden text-muted text-[14px] sm:inline"
                    aria-hidden="true"
                  >
                    arrow_forward
                  </span>
                  <input
                    type="text"
                    list="mitm-api-keys"
                    value={selectedApiKey}
                    onChange={(e) => setSelectedApiKey(e.target.value)}
                    placeholder={
                      cloudEnabled ? "Enter or pick API key" : `${ACTIVE.defaultApiKey} (default)`
                    }
                    className="flex-1 min-w-0 px-2 py-1.5 bg-panel rounded border border-line text-xs text-text focus:outline-none focus:ring-1 focus:ring-coral/50"
                  />
                  {apiKeys?.length > 0 && (
                    <datalist id="mitm-api-keys">
                      {apiKeys.map((key) => (
                        <option key={key.id} value={key.key}>
                          {key.name || key.key}
                        </option>
                      ))}
                    </datalist>
                  )}
                </div>
              ))}
          </div>

          {/* Action buttons */}
          <div
            className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center"
            data-i18n-skip="true"
          >
            {status?.certExists && !status?.certTrusted && (
              <Button
                variant="secondary"
                size="sm"
                icon="verified_user"
                onClick={() => handleAction("trust-cert")}
                disabled={loading}
                className="w-full sm:w-auto"
              >
                Trust Cert
              </Button>
            )}
            {isRunning ? (
              <Button
                variant="danger"
                size="sm"
                icon="stop_circle"
                onClick={() => handleAction("stop")}
                disabled={loading}
                className="w-full sm:w-auto"
              >
                Stop Server
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                icon="play_circle"
                onClick={() => handleAction("start")}
                disabled={loading || !status || statusFailed || (serverIsWindows && !isAdmin)}
                title={
                  statusFailed
                    ? "Status unavailable — reload the page before starting"
                    : serverIsWindows && !isAdmin
                      ? "Administrator required"
                      : undefined
                }
                className="w-full sm:w-auto"
              >
                Start Server
              </Button>
            )}
            {isRunning && (
              <p className="text-xs text-muted">
                Enable DNS per tool below to activate interception
              </p>
            )}
          </div>

          {/* Action error */}
          {statusFailed && !status && (
            <div className="flex items-start gap-2 px-2 py-1.5 rounded text-xs bg-warn-bg text-warn border border-warn/20">
              <span
                className="material-symbols-outlined text-[14px] mt-0.5 shrink-0"
                aria-hidden="true"
              >
                warning
              </span>
              <span role="status">
                Status unavailable — start is disabled until the server reports the storage mode. No
                key fallback is assumed.
              </span>
            </div>
          )}
          {statusFailed && status && (
            <div className="flex items-start gap-2 px-2 py-1.5 rounded text-xs bg-warn-bg text-warn border border-warn/20">
              <span
                className="material-symbols-outlined text-[14px] mt-0.5 shrink-0"
                aria-hidden="true"
              >
                warning
              </span>
              <span role="status">
                Status refresh failed — showing the last known state. Start stays available only
                from that confirmed snapshot.
              </span>
            </div>
          )}
          {actionError && (
            <div className="flex items-start gap-2 px-2 py-1.5 rounded text-xs bg-err-bg text-err dark:text-red-400 border border-red-500/20">
              <span
                className="material-symbols-outlined text-[14px] mt-0.5 shrink-0"
                aria-hidden="true"
              >
                error
              </span>
              <span>{actionError}</span>
            </div>
          )}

          {/* Windows admin warning */}
          {serverIsWindows && !isAdmin && (
            <div className="flex items-center gap-2 px-2 py-1.5 rounded text-xs bg-err-bg text-err border border-red-500/20">
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                shield_lock
              </span>
              <span>{`Administrator required — restart ${ACTIVE.name} as Administrator to use MITM`}</span>
            </div>
          )}
        </div>
      </Card>

      {/* Password Modal */}
      <Modal
        isOpen={showPasswordModal}
        onClose={() => {
          if (loading) return;
          setShowPasswordModal(false);
          setSudoPassword("");
          setModalError(null);
        }}
        title="Sudo password required"
        size="sm"
        closeOnOverlay={!loading}
        closeOnEscape={!loading}
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3 p-3 border border-warn bg-warn-bg rounded-lg">
            <span className="material-symbols-outlined text-warn text-[20px]" aria-hidden="true">
              warning
            </span>
            <p className="text-xs text-muted">Required for SSL certificate and server startup</p>
          </div>
          <Input
            type="password"
            placeholder="Enter sudo password"
            value={sudoPassword}
            onChange={(e) => setSudoPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !loading) handleConfirmPassword();
            }}
          />
          {modalError && (
            <div className="flex items-center gap-2 px-2 py-1.5 rounded text-xs bg-err-bg text-err">
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                error
              </span>
              <span>{modalError}</span>
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowPasswordModal(false);
                setSudoPassword("");
                setModalError(null);
              }}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleConfirmPassword} loading={loading}>
              Confirm
            </Button>
          </div>
        </div>
      </Modal>

      {/* Port 443 Conflict Modal */}
      <Modal
        isOpen={Boolean(port443Conflict)}
        onClose={() => {
          if (loading) return;
          setPort443Conflict(null);
          setLoading(false);
        }}
        title="Port 443 already in use"
        closeOnOverlay={false}
        closeOnEscape={!loading}
      >
        {port443Conflict ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3 p-3 border border-warn bg-warn-bg rounded-lg">
              <span className="material-symbols-outlined text-warn text-[20px]" aria-hidden="true">
                warning
              </span>
              <div className="flex flex-col gap-1 text-xs text-muted">
                <p>Port 443 is currently used by another process:</p>
                <p className="font-mono text-text" data-i18n-skip="true">
                  {port443Conflict.owner.name} (PID {port443Conflict.owner.pid})
                </p>
                <p>Kill this process to start MITM server?</p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPort443Conflict(null);
                  setLoading(false);
                }}
                disabled={loading}
              >
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={handleKillAndStart} loading={loading}>
                Kill & start
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
