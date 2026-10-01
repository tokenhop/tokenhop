"use client";

import PropTypes from "prop-types";
import { useState, useEffect, useRef } from "react";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Modal from "@/shared/components/Modal";
import Callout from "@/shared/components/Callout";
import ModelSelectModal from "@/shared/components/ModelSelectModal";
import ApiKeySelect from "./ApiKeySelect";
import SetupScaffold, { ModelRow, SetupRow } from "./SetupScaffold";
import { resolveApiKey } from "./setupCard";

/**
 * Legacy Antigravity MITM interception card: start/stop the MITM proxy
 * (Cert → Server → DNS) and map Antigravity model aliases to 9Router models.
 * The MITM page uses MitmServerCard + MitmToolCard instead; this card stays
 * for the cli-tools surface until the old list is removed.
 */
export default function AntigravityToolCard({
  tool,
  apiKeys = [],
  activeProviders = [],
  hasActiveProviders = false,
  cloudEnabled = false,
  onStatusUpdate,
}) {
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(false);
  const [startingStep, setStartingStep] = useState(null);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [sudoPassword, setSudoPassword] = useState("");
  const [selectedApiKey, setSelectedApiKey] = useState("");
  const [message, setMessage] = useState(null);
  const [modelMappings, setModelMappings] = useState({});
  const [modalOpen, setModalOpen] = useState(false);
  const [currentEditingAlias, setCurrentEditingAlias] = useState(null);
  const [modelAliases, setModelAliases] = useState({});
  // Latest callback in a ref so the mount fetch below never re-runs on a new
  // callback identity (see setupCard.js).
  const onStatusUpdateRef = useRef(onStatusUpdate);
  useEffect(() => {
    onStatusUpdateRef.current = onStatusUpdate;
  }, [onStatusUpdate]);

  useEffect(() => {
    if (apiKeys?.length > 0 && !selectedApiKey) setSelectedApiKey(apiKeys[0].key);
  }, [apiKeys, selectedApiKey]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/cli-tools/antigravity-mitm");
        if (res.ok) {
          const data = await res.json();
          setStatus(data);
          onStatusUpdateRef.current?.("antigravity", data);
        }
      } catch {
        setStatus({ running: false });
      } finally {
        setChecking(false);
      }
      try {
        const res = await fetch("/api/cli-tools/antigravity-mitm/alias?tool=antigravity");
        if (res.ok) {
          const data = await res.json();
          if (Object.keys(data.aliases || {}).length > 0) setModelMappings(data.aliases);
        }
      } catch {
        /* ignore */
      }
      try {
        const res = await fetch("/api/models/alias");
        if (res.ok) {
          const data = await res.json();
          setModelAliases(data.aliases || {});
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const fetchStatus = async () => {
    try {
      const res = await fetch("/api/cli-tools/antigravity-mitm");
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
        onStatusUpdateRef.current?.("antigravity", data);
      }
    } catch {
      setStatus({ running: false });
    }
  };

  const serverIsWindows = status?.isWin === true;
  const canRunWithoutPassword =
    serverIsWindows || status?.hasCachedPassword || status?.needsSudoPassword === false;

  const doStart = async (password) => {
    setLoading(true);
    setMessage(null);
    setStartingStep("cert");
    try {
      const res = await fetch("/api/cli-tools/antigravity-mitm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: resolveApiKey(selectedApiKey, apiKeys, cloudEnabled),
          sudoPassword: password,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: "MITM started." });
        setShowPasswordModal(false);
        setSudoPassword("");
        fetchStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to start MITM." });
      }
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setStartingStep(null);
      setLoading(false);
    }
  };

  const doStop = async (password) => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/api/cli-tools/antigravity-mitm", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sudoPassword: password }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: "MITM stopped." });
        setShowPasswordModal(false);
        setSudoPassword("");
        fetchStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to stop MITM." });
      }
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmPassword = () => {
    if (!sudoPassword.trim()) {
      setMessage({ type: "error", text: "Sudo password is required." });
      return;
    }
    if (status?.running) doStop(sudoPassword);
    else doStart(sudoPassword);
  };

  const handleSaveMappings = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/api/cli-tools/antigravity-mitm/alias", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "antigravity", mappings: modelMappings }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save mappings.");
      }
      setMessage({ type: "success", text: "Mappings saved." });
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const isRunning = status?.running;

  const stepState = (key, ok) => {
    if (startingStep === key) return "loading";
    return ok ? "done" : "pending";
  };

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={
          status
            ? isRunning
              ? { label: "Active", variant: "ok" }
              : { label: "Inactive", variant: "neutral" }
            : null
        }
        checking={checking}
        checkingLabel="Checking MITM status..."
        message={message}
        onApply={() =>
          isRunning ? doStop("") : canRunWithoutPassword ? doStart("") : setShowPasswordModal(true)
        }
        applyLabel={isRunning ? "Stop MITM" : "Start MITM"}
        applyDisabled={loading || (!isRunning && !hasActiveProviders)}
        applying={loading}
        onReset={handleSaveMappings}
        resetLabel="Save mappings"
        resetDisabled={loading || Object.keys(modelMappings).length === 0}
        resetting={loading}
        onManualConfig={() => {}}
        manualDisabled
        fileHint=""
      >
        <div className="flex items-center gap-1" role="status" aria-label="MITM startup progress">
          {[
            { key: "cert", label: "Cert", ok: status?.certExists },
            { key: "server", label: "Server", ok: status?.running },
            { key: "dns", label: "DNS", ok: status?.dnsConfigured },
          ].map(({ key, label, ok }, i) => {
            const st = stepState(key, ok);
            return (
              <div key={key} className="flex items-center">
                <div className="flex items-center gap-1.5 rounded-lg px-2 py-1">
                  <span
                    className={`material-symbols-outlined text-[14px] ${
                      st === "loading" ? "animate-spin text-coral" : ok ? "text-ok" : "text-subtle"
                    }`}
                    aria-hidden="true"
                  >
                    {st === "loading"
                      ? "progress_activity"
                      : ok
                        ? "check_circle"
                        : "radio_button_unchecked"}
                  </span>
                  <span
                    className={`text-xs font-semibold ${
                      st === "loading" ? "text-coral" : ok ? "text-ok" : "text-muted"
                    }`}
                  >
                    {label}
                  </span>
                </div>
                {i < 2 && (
                  <span
                    className="material-symbols-outlined text-[12px] text-subtle"
                    aria-hidden="true"
                  >
                    arrow_forward
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {isRunning && (
          <>
            <SetupRow label="API key">
              <ApiKeySelect
                value={selectedApiKey}
                onChange={setSelectedApiKey}
                apiKeys={apiKeys}
                cloudEnabled={cloudEnabled}
              />
            </SetupRow>
            <div className="flex flex-col gap-2">
              <span className="text-[13px] font-semibold text-text">Model mapping</span>
              {(tool.defaultModels || []).map((m) => (
                <ModelRow
                  key={m.alias}
                  label={m.name}
                  value={modelMappings[m.alias] || ""}
                  onChange={(val) => setModelMappings((prev) => ({ ...prev, [m.alias]: val }))}
                  onPick={() => {
                    setCurrentEditingAlias(m.alias);
                    setModalOpen(true);
                  }}
                  pickDisabled={!hasActiveProviders}
                  pickLabel={`Select model for ${m.alias}`}
                />
              ))}
            </div>
          </>
        )}

        {!isRunning && serverIsWindows && (
          <Callout variant="warn">
            Windows: run the 9Router terminal as Administrator to enable MITM.
          </Callout>
        )}

        {!isRunning && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[13px] text-muted">
              <span className="font-semibold text-text">How it works:</span> intercepts Antigravity
              traffic via DNS redirect, letting you reroute models through 9Router.
            </p>
            <ol className="flex list-none flex-col gap-0.5 p-0 text-xs text-muted">
              <li>1. Generates SSL cert and adds it to the system keychain</li>
              <li>
                2. Redirects <code className="font-mono">daily-cloudcode-pa.googleapis.com</code> to
                localhost
              </li>
              <li>3. Maps Antigravity models to any provider via 9Router</li>
            </ol>
          </div>
        )}
      </SetupScaffold>

      <Modal
        isOpen={showPasswordModal}
        onClose={() => {
          setShowPasswordModal(false);
          setSudoPassword("");
          setMessage(null);
        }}
        title="Sudo password required"
        size="sm"
      >
        <div className="flex flex-col gap-3">
          <Callout variant="warn">Required for SSL certificate and DNS configuration.</Callout>
          <Input
            type="password"
            label="Sudo password"
            placeholder="Enter sudo password"
            value={sudoPassword}
            onChange={(e) => setSudoPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !loading) handleConfirmPassword();
            }}
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowPasswordModal(false);
                setSudoPassword("");
                setMessage(null);
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

      {modalOpen && (
        <ModelSelectModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          onSelect={(m) => {
            if (currentEditingAlias) {
              setModelMappings((prev) => ({ ...prev, [currentEditingAlias]: m.value }));
            }
            setModalOpen(false);
          }}
          selectedModel={currentEditingAlias ? modelMappings[currentEditingAlias] : null}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title={`Select model for ${currentEditingAlias}`}
        />
      )}
    </>
  );
}

AntigravityToolCard.propTypes = {
  tool: PropTypes.shape({
    name: PropTypes.string.isRequired,
    color: PropTypes.string,
    description: PropTypes.string,
    defaultModels: PropTypes.array,
  }).isRequired,
  apiKeys: PropTypes.array,
  activeProviders: PropTypes.array,
  hasActiveProviders: PropTypes.bool,
  cloudEnabled: PropTypes.bool,
  onStatusUpdate: PropTypes.func,
};
