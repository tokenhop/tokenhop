"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Badge, Input, Modal } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { readMitmResponse } from "./mitmToolActions";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";

/**
 * Shared MITM infrastructure card — manages SSL cert + server start/stop.
 * DNS per-tool is handled separately in MitmToolCard.
 */
export default function MitmServerCard({ apiKeys, cloudEnabled, onStatusChange }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [sudoPassword, setSudoPassword] = useState("");
  const [selectedApiKey, setSelectedApiKey] = useState(() => apiKeys?.[0]?.key || "");
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
      const data = await readMitmResponse(res, "Failed to load MITM status");
      setStatus(data);
      if (data.mitmRouterBaseUrl) {
        setMitmRouterBaseUrl(data.mitmRouterBaseUrl);
      }
      onStatusChange?.(data);
    } catch (error) {
      // Keep the card visible: stale controls are better than a blank page,
      // but the failed refresh must say so.
      notifyError(`Couldn't load MITM server status: ${error.message || "Network error"}.`);
    }
  }, [notifyError, onStatusChange]);

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
    try {
      let res;
      if (action === "trust-cert") {
        res = await fetch("/api/cli-tools/antigravity-mitm", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "trust-cert", sudoPassword: password }),
        });
      } else if (action === "start") {
        const keyToUse =
          selectedApiKey?.trim() ||
          (apiKeys?.length > 0 ? apiKeys[0].key : null) ||
          (!cloudEnabled ? "sk_9router" : null);
        res = await fetch("/api/cli-tools/antigravity-mitm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apiKey: keyToUse,
            sudoPassword: password,
            mitmRouterBaseUrl: mitmRouterBaseUrl.trim() || DEFAULT_MITM_ROUTER_BASE,
            forceKillPort443,
          }),
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
          setPort443Conflict({ owner: data.portOwner, password });
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
      setLoading(false);
      setPendingAction(null);
    }
  };

  const handleKillAndStart = () => {
    const pwd = port443Conflict?.password || "";
    doAction("start", pwd, true);
  };

  const handleConfirmPassword = () => {
    if (!sudoPassword.trim()) {
      setModalError("Sudo password is required");
      return;
    }
    doAction(pendingAction, sudoPassword);
  };

  const isRunning = status?.running;

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
              <span className="font-semibold text-sm text-text">MITM Server</span>
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
              <span className="font-medium text-text">Purpose:</span> Use Antigravity IDE & GitHub
              Copilot → with ANY provider/model from 9Router
            </p>
            <p className="text-[11px] text-muted leading-relaxed">
              <span className="font-medium text-text">How it works:</span> Antigravity/Copilot IDE
              request → DNS redirect to localhost:443 → MITM proxy intercepts → 9Router → response
              to Antigravity/Copilot
            </p>
          </div>

          {/* Base URL + API Key — same row pattern as Claude Code / cli-tools */}
          <div className="flex flex-col gap-2">
            <div className="grid gap-1 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
              <span className="text-xs font-semibold text-text sm:text-right sm:text-sm">
                9Router Base URL
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
                onChange={(e) => setMitmRouterBaseUrl(e.target.value)}
                placeholder={DEFAULT_MITM_ROUTER_BASE}
                disabled={isRunning}
                className="flex-1 min-w-0 px-2 py-1.5 bg-panel rounded border border-line text-xs text-text focus:outline-none focus:ring-1 focus:ring-coral/50 disabled:opacity-50"
              />
            </div>
            {!isRunning && (
              <div className="grid gap-1 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                <span className="text-xs font-semibold text-text sm:text-right sm:text-sm">
                  API Key
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
                  placeholder={cloudEnabled ? "Enter or pick API key" : "sk_9router (default)"}
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
            )}
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
                disabled={loading || !status || (serverIsWindows && !isAdmin)}
                title={serverIsWindows && !isAdmin ? "Administrator required" : undefined}
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
              <span>Administrator required — restart 9Router as Administrator to use MITM</span>
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
        title="Sudo Password Required"
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
        title="Port 443 Already In Use"
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
                <p>Kill this process to start MITM Server?</p>
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
                Kill & Start
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
