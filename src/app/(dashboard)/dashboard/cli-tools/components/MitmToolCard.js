"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Card, Button, Badge, Input, ModelSelectModal, Modal } from "@/shared/components";
import { TOOL_HOSTS } from "@/shared/constants/mitmToolHosts";
import { useNotificationStore } from "@/store/notificationStore";
import Image from "next/image";
import {
  createLatestSaveQueue,
  mitmFailureMessage,
  readMitmResponse,
  resolveSaveVisibility,
  restoredMappings,
} from "./mitmToolActions";

/**
 * Per-tool MITM card — shows DNS status + model mappings.
 * - Auto-saves model mapping on blur or modal select
 * - Skips sudo modal if password is already cached
 * - Model mappings can only be edited when DNS is active
 */
export default function MitmToolCard({
  tool,
  isExpanded,
  onToggle,
  serverRunning,
  dnsActive,
  hasCachedPassword,
  needsSudoPassword,
  isWin,
  apiKeys,
  activeProviders,
  hasActiveProviders,
  modelAliases = {},
  cloudEnabled,
  onDnsChange,
}) {
  const [loading, setLoading] = useState(false);
  const [warning, setWarning] = useState(null);
  const [dnsError, setDnsError] = useState(null);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [sudoPassword, setSudoPassword] = useState("");
  const [pendingDnsAction, setPendingDnsAction] = useState(null);
  const [modalError, setModalError] = useState(null);
  const [modelMappings, setModelMappings] = useState({});
  const [modalOpen, setModalOpen] = useState(false);
  const [currentEditingAlias, setCurrentEditingAlias] = useState(null);
  const savedMappings = useRef({});
  const editGeneration = useRef(0);
  const saveEpoch = useRef(0);
  const savePending = useRef(0);
  const loadGeneration = useRef(0);
  const notifyError = useNotificationStore((state) => state.error);

  const mitmHosts = TOOL_HOSTS[tool.id] ?? [];
  const canRunWithoutPassword = isWin || hasCachedPassword || needsSudoPassword === false;

  // A load that finishes after the user typed must not clobber the newer
  // local text; server state still advances for the next blur PUT.
  const loadSavedMappings = useCallback(async () => {
    const editGenerationAtStart = editGeneration.current;
    const saveEpochAtStart = saveEpoch.current;
    const thisLoad = ++loadGeneration.current;
    try {
      const res = await fetch(`/api/cli-tools/antigravity-mitm/alias?tool=${tool.id}`);
      const data = await readMitmResponse(res, "Failed to load aliases");
      // A finished save or a newer started load supersedes this GET result.
      if (
        saveEpochAtStart !== saveEpoch.current ||
        savePending.current > 0 ||
        thisLoad !== loadGeneration.current
      ) {
        return true;
      }
      savedMappings.current = restoredMappings(data.aliases);
      setModelMappings((visible) =>
        resolveSaveVisibility(
          visible,
          editGeneration.current,
          savedMappings.current,
          editGenerationAtStart,
        ),
      );
      return true;
    } catch (error) {
      notifyError(mitmFailureMessage("load", tool.name, error.message));
      return false;
    }
  }, [tool.id, tool.name, notifyError]);

  useEffect(() => {
    if (isExpanded) loadSavedMappings();
  }, [isExpanded, loadSavedMappings]);

  // Whole-map PUTs run one at a time; only the newest result touches state,
  // so a slow earlier save can never overwrite a later edit.
  const enqueueSave = useMemo(
    () =>
      createLatestSaveQueue(async (mappings) => {
        const res = await fetch("/api/cli-tools/antigravity-mitm/alias", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool: tool.id, mappings }),
        });
        const data = await readMitmResponse(res, "Failed to save aliases");
        return data.aliases ?? mappings;
      }),
    [tool.id],
  );

  const saveMappings = useCallback(
    async (mappings) => {
      const submittedEditGeneration = editGeneration.current;
      savePending.current += 1;
      let result;
      try {
        result = await enqueueSave(mappings);
      } finally {
        savePending.current -= 1;
      }
      saveEpoch.current += 1;
      if (result.error) {
        // A failed PUT must never leave the unsaved optimistic edit visible.
        // Roll back to the last server-confirmed map; no refetch, so it can't
        // race a newer queued save. Older failures defer to the newest save.
        if (!result.latest) return;
        notifyError(mitmFailureMessage("save", tool.name, result.error.message));
        setModelMappings((visible) =>
          resolveSaveVisibility(
            visible,
            editGeneration.current,
            savedMappings.current,
            submittedEditGeneration,
          ),
        );
        return;
      }
      savedMappings.current = restoredMappings(result.saved);
      if (!result.latest) return;
      setModelMappings((visible) =>
        resolveSaveVisibility(
          visible,
          editGeneration.current,
          savedMappings.current,
          submittedEditGeneration,
        ),
      );
    },
    [enqueueSave, tool.name, notifyError],
  );

  const handleMappingBlur = (alias, value) => {
    editGeneration.current += 1;
    saveMappings({ ...modelMappings, [alias]: value });
  };

  const handleModelMappingChange = (alias, value) => {
    editGeneration.current += 1;
    setModelMappings((prev) => ({ ...prev, [alias]: value }));
  };

  const openModelSelector = (alias) => {
    setCurrentEditingAlias(alias);
    setModalOpen(true);
  };

  const handleModelSelect = (model) => {
    if (!currentEditingAlias || model.isPlaceholder) return;
    editGeneration.current += 1;
    const updated = { ...modelMappings, [currentEditingAlias]: model.value };
    setModelMappings(updated);
    saveMappings(updated);
  };

  const handleDnsToggle = () => {
    if (!serverRunning) return;
    const action = dnsActive ? "disable" : "enable";
    if (canRunWithoutPassword) {
      doDnsAction(action, "");
    } else {
      setPendingDnsAction(action);
      setShowPasswordModal(true);
      setModalError(null);
    }
  };

  const doDnsAction = async (action, password) => {
    setLoading(true);
    setWarning(null);
    setDnsError(null);
    try {
      const res = await fetch("/api/cli-tools/antigravity-mitm", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: tool.id, action, sudoPassword: password }),
      });
      const data = await readMitmResponse(res, "Failed to toggle DNS");

      if (action === "enable") {
        setWarning(`Restart ${tool.name} to apply changes`);
      }

      setShowPasswordModal(false);
      setSudoPassword("");
      setPendingDnsAction(null);
      onDnsChange?.(data);
    } catch (error) {
      // DNS state stays as the server last reported; show the failure inline
      // (and in the sudo modal when it is open) instead of pretending success.
      // The pending action stays set so Confirm in the open modal retries it.
      const message = mitmFailureMessage(action, tool.name, error.message);
      setDnsError(message);
      setModalError(error.message || "Failed to toggle DNS");
      notifyError(message);
    } finally {
      setLoading(false);
    }
  };

  const closePasswordModal = () => {
    setShowPasswordModal(false);
    setSudoPassword("");
    setModalError(null);
    setPendingDnsAction(null);
  };

  const handleConfirmPassword = () => {
    if (!sudoPassword.trim()) {
      setModalError("Sudo password is required");
      return;
    }
    doDnsAction(pendingDnsAction, sudoPassword);
  };

  return (
    <>
      <Card padding="xs" className="overflow-hidden">
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={onToggle}
          className="flex w-full items-start justify-between gap-3 text-start hover:cursor-pointer focus-visible:outline-none focus-visible:shadow-focus sm:items-center"
        >
          <span className="flex min-w-0 items-center gap-3">
            <span className="size-8 flex items-center justify-center shrink-0" aria-hidden="true">
              <Image
                src={tool.image}
                alt=""
                width={32}
                height={32}
                className="size-8 object-contain rounded-lg"
                sizes="32px"
                onError={(e) => {
                  e.target.style.display = "none";
                }}
                loading="lazy"
                decoding="async"
              />
            </span>
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-sm">{tool.name}</span>
                {!serverRunning ? (
                  <Badge variant="default" size="sm">
                    Server off
                  </Badge>
                ) : dnsActive ? (
                  <Badge variant="success" size="sm">
                    Active
                  </Badge>
                ) : (
                  <Badge variant="warning" size="sm">
                    DNS off
                  </Badge>
                )}
              </span>
              <span className="block text-xs text-muted sm:truncate">
                Intercept {tool.name} requests via MITM proxy
              </span>
            </span>
          </span>
          <span
            className={`material-symbols-outlined text-muted text-[20px] transition-transform ${isExpanded ? "rotate-180" : ""}`}
            aria-hidden="true"
          >
            expand_more
          </span>
        </button>

        {isExpanded && (
          <div className="mt-4 pt-4 border-t border-line flex flex-col gap-4">
            {/* Hosts */}
            {mitmHosts.length > 0 && (
              <div className="mt-2 rounded-md border border-line bg-panel/50 px-2 py-1.5">
                <p className="text-[10px] font-medium tracking-wide text-text/80 mb-1">
                  Edit hosts file manually to add the following entries:
                </p>
                <ul className="list-none space-y-0.5 font-mono text-[10px] text-muted break-all">
                  {mitmHosts.map((h) => (
                    <li key={h}>127.0.0.1 {h}</li>
                  ))}
                </ul>
              </div>
            )}
            {/* Info */}
            <div className="flex flex-col gap-0.5 text-[11px] text-muted px-1">
              <p>Toggle DNS to redirect {tool.name} traffic through 9Router via MITM.</p>
              {!dnsActive && (
                <p className="text-amber-600 text-[10px] mt-1">Enable DNS to edit model mappings</p>
              )}
            </div>

            {/* Model Mappings */}
            {tool.defaultModels?.length > 0 && (
              <div className="flex flex-col gap-2">
                {tool.defaultModels.map((model) => (
                  <div
                    key={model.alias}
                    className="grid grid-cols-1 gap-1.5 sm:grid-cols-[9rem_auto_1fr_auto] sm:items-center sm:gap-2"
                  >
                    <span className="text-xs font-semibold text-text sm:text-right">
                      {model.name}
                    </span>
                    <span
                      className="material-symbols-outlined hidden text-muted text-[14px] sm:inline"
                      aria-hidden="true"
                    >
                      arrow_forward
                    </span>
                    <div className="relative w-full min-w-0">
                      <input
                        type="text"
                        value={modelMappings[model.alias] || ""}
                        onChange={(e) => handleModelMappingChange(model.alias, e.target.value)}
                        onBlur={(e) => handleMappingBlur(model.alias, e.target.value)}
                        placeholder="provider/model-id"
                        disabled={!dnsActive}
                        className={`w-full min-w-0 pl-2 pr-7 py-2 bg-panel rounded border border-line text-xs focus:outline-none focus:ring-1 focus:ring-coral/50 sm:py-1.5 ${!dnsActive ? "opacity-50 cursor-not-allowed" : ""}`}
                      />
                      {modelMappings[model.alias] && (
                        <button
                          onClick={() => {
                            handleModelMappingChange(model.alias, "");
                            saveMappings({ ...modelMappings, [model.alias]: "" });
                          }}
                          className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-muted hover:text-red-500 rounded transition-colors"
                          title="Clear"
                        >
                          <span
                            className="material-symbols-outlined text-[14px]"
                            aria-hidden="true"
                          >
                            close
                          </span>
                        </button>
                      )}
                    </div>
                    <button
                      onClick={() => openModelSelector(model.alias)}
                      disabled={!hasActiveProviders || !dnsActive}
                      className={`rounded border px-2 py-2 text-xs transition-colors sm:py-1.5 ${hasActiveProviders && dnsActive ? "bg-panel border-line hover:border-coral cursor-pointer" : "opacity-50 cursor-not-allowed border-line"}`}
                    >
                      Select
                    </button>
                  </div>
                ))}
              </div>
            )}

            {tool.defaultModels?.length === 0 && (
              <p className="text-xs text-muted px-1">Model mappings will be available soon.</p>
            )}

            {/* Start / Stop DNS button */}
            <div className="flex flex-col gap-2 sm:items-start">
              {dnsActive ? (
                <Button
                  variant="danger"
                  size="sm"
                  icon="stop_circle"
                  onClick={handleDnsToggle}
                  disabled={!serverRunning || loading}
                  className="w-full sm:w-auto"
                >
                  Stop DNS
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  icon="play_circle"
                  onClick={handleDnsToggle}
                  disabled={!serverRunning || loading}
                  className="w-full sm:w-auto"
                >
                  Start DNS
                </Button>
              )}

              {/* Warning below button */}
              {warning && (
                <div className="flex items-center gap-2 px-2 py-1.5 rounded text-xs text-amber-500">
                  <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                    warning
                  </span>
                  <span>{warning}</span>
                </div>
              )}
              {dnsError && (
                <p role="alert" className="flex items-center gap-2 text-xs text-err">
                  <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                    error
                  </span>
                  <span>{dnsError}</span>
                </p>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* Password Modal */}
      <Modal
        isOpen={showPasswordModal}
        onClose={() => {
          if (loading) return;
          closePasswordModal();
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
            <p className="text-xs text-muted">Required to modify /etc/hosts and flush DNS cache</p>
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
            <Button variant="ghost" size="sm" onClick={closePasswordModal} disabled={loading}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleConfirmPassword} loading={loading}>
              Confirm
            </Button>
          </div>
        </div>
      </Modal>

      {/* Model Select Modal */}
      {modalOpen && (
        <ModelSelectModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          onSelect={handleModelSelect}
          selectedModel={currentEditingAlias ? modelMappings[currentEditingAlias] : null}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title={`Select model for ${currentEditingAlias}`}
        />
      )}
    </>
  );
}
