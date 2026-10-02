"use client";

import PropTypes from "prop-types";
import { useState, useEffect, useRef } from "react";
import ModelSelectModal from "@/shared/components/ModelSelectModal";
import ManualConfigModal from "@/shared/components/ManualConfigModal";
import ApiKeySelect from "./ApiKeySelect";
import EndpointSegmentedPicker from "./EndpointSegmentedPicker";
import SetupScaffold, { NotInstalledBlock, SetupRow, SingleModelRow } from "./SetupScaffold";
import { rememberEndpoint } from "./cliEndpointPresets";
import { matchKnownEndpoint } from "./cliEndpointMatch";
import { deriveToolStatus } from "../lib/toolStatus";
import {
  asList,
  asMap,
  asObjectList,
  apiKeyPatch,
  resolveSelectedApiKey,
  savedEndpointUrl,
  useSetupSettings,
} from "../hooks/useSetupSettings";
import { markLocalOnly, useCliAccessStore } from "@/store/cliAccessStore";
import { isLocalOnlyResponse } from "@/shared/utils/localOnly";

const LOCAL_ONLY = Symbol("localOnly");

/**
 * Shared hook for the panel-style setup cards. Owns status fetching,
 * busy/message state and model aliases. Per-tool cards own their model
 * state, persisted fields (`useSetupSettings`) and POST bodies.
 */
export function useSetupCard({
  statusUrl,
  aliasesUrl = "/api/models/alias",
  onStatusUpdate,
  toolId,
}) {
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(() => !useCliAccessStore.getState().localOnly);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [showManualModal, setShowManualModal] = useState(false);
  const [modelAliases, setModelAliases] = useState({});

  // Callback-ref pattern: the page re-renders (and passes a new callback
  // identity) after every status update. Depending on that identity would
  // retrigger this effect per render — the cli-tools request loop. The latest
  // callback goes in a ref; only real inputs re-trigger the fetch.
  const onStatusUpdateRef = useRef(onStatusUpdate);
  useEffect(() => {
    onStatusUpdateRef.current = onStatusUpdate;
  }, [onStatusUpdate]);

  const fetchStatus = async () => {
    if (useCliAccessStore.getState().localOnly) {
      setChecking(false);
      return;
    }
    setChecking(true);
    try {
      const res = await fetch(statusUrl);
      if (await isLocalOnlyResponse(res)) return markLocalOnly();
      const data = await res.json();
      setStatus(data);
      onStatusUpdateRef.current?.(toolId, data);
    } catch (err) {
      setStatus({ installed: false, error: err.message });
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    if (useCliAccessStore.getState().localOnly) {
      setChecking(false);
    } else {
      fetch(statusUrl)
        .then(async (res) => ((await isLocalOnlyResponse(res)) ? LOCAL_ONLY : res.json()))
        .then((data) => {
          if (cancelled) return;
          if (data === LOCAL_ONLY) return markLocalOnly();
          setStatus(data);
          onStatusUpdateRef.current?.(toolId, data);
        })
        .catch((err) => {
          if (!cancelled) setStatus({ installed: false, error: err.message });
        })
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    }
    fetch(aliasesUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setModelAliases(data.aliases || {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [statusUrl, aliasesUrl, toolId]);

  return {
    status,
    setStatus,
    fetchStatus,
    checking,
    applying,
    setApplying,
    restoring,
    setRestoring,
    message,
    setMessage,
    showInstallGuide,
    setShowInstallGuide,
    modalOpen,
    setModalOpen,
    showManualModal,
    setShowManualModal,
    modelAliases,
  };
}

export const setupCardPropTypes = {
  tool: PropTypes.object.isRequired,
  baseUrl: PropTypes.string,
  apiKeys: PropTypes.array,
  cloudEnabled: PropTypes.bool,
  cloudUrl: PropTypes.string,
  tunnelEnabled: PropTypes.bool,
  tunnelPublicUrl: PropTypes.string,
  tailscaleEnabled: PropTypes.bool,
  tailscaleUrl: PropTypes.string,
  activeProviders: PropTypes.array,
  hasActiveProviders: PropTypes.bool,
  modelAliases: PropTypes.object,
  onStatusUpdate: PropTypes.func,
};

export {
  API_KEY_PLACEHOLDER,
  resolveApiKey,
  manualApiKey,
  toManualConfigs,
} from "@/lib/cliToolConfigs/shared";

export {
  useSetupSettings,
  asList,
  asMap,
  asObjectList,
  resolveSelectedApiKey,
  apiKeyPatch,
  savedEndpointUrl,
  ApiKeySelect,
  EndpointSegmentedPicker,
  SetupScaffold,
  NotInstalledBlock,
  SetupRow,
  SingleModelRow,
  ModelSelectModal,
  ManualConfigModal,
  rememberEndpoint,
  matchKnownEndpoint,
  deriveToolStatus,
};
