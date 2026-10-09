"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import useOAuthCallbackListener from "@/shared/hooks/useOAuthCallbackListener";
import useOAuthProxyStatus from "@/shared/hooks/useOAuthProxyStatus";
import { PASTE_TOKEN_PROVIDERS } from "@/shared/components/ProxyOAuthPanel";
import {
  DEVICE_CODE_PROVIDERS,
  PROXY_OAUTH_PROVIDERS,
  buildDeviceExtraData,
  buildProxyRegisterBody,
  buildRedirectUri,
  classifyDevicePoll,
  devicePollTimeoutMs,
  flowCancelled,
  isLocalhostHostname,
  nextDevicePollInterval,
  parseManualCallback,
} from "@/shared/components/oauth/authFlowHelpers";
import { withOAuthWorkspace } from "@/shared/utils/oauthWorkspace";
import { useAuthStatusState } from "./useAuthStatus";
import { accountView } from "@/shared/utils/account";

const POPUP_FEATURES = "width=600,height=700";
const emptyLedger = () => ({ proxyStarted: false, proxyProvider: null, stopSent: false });

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

/** Start codex/xai fixed-port server-side proxy. Returns `{active, serverSide}`. */
async function startFixedPortProxy(provider, appPort, data, redirectUri, workspaceId = null) {
  const proxyUrl = new URL(`/api/oauth/${provider}/start-proxy`, window.location.origin);
  proxyUrl.searchParams.set("app_port", appPort);
  proxyUrl.searchParams.set("state", data.state);
  proxyUrl.searchParams.set("code_verifier", data.codeVerifier);
  proxyUrl.searchParams.set("redirect_uri", redirectUri);
  const proxyRes = await fetch(withOAuthWorkspace(proxyUrl.toString(), workspaceId));
  const proxyData = await proxyRes.json();
  return {
    active: proxyData.success,
    serverSide: !!proxyData.serverSide,
    reason: proxyData.reason,
  };
}

/**
 * OAuth modal state machine: device code, auth code popup/manual paste,
 * codex/xai fixed-port proxy, trae/windsurf/zed dynamic proxy, paste-token.
 * Steps: waiting | input | success | error.
 */
export default function useOAuthFlow({
  isOpen,
  provider,
  oauthMeta,
  idcConfig,
  onSuccess,
  onClose,
  workspaceId = null,
}) {
  const { status: remoteStatus, loaded: remoteReady } = useAuthStatusState();
  const hostOnly =
    accountView(remoteStatus).active &&
    typeof window !== "undefined" &&
    !isLocalhostHostname(window.location.hostname);
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  const ws = useCallback((url) => withOAuthWorkspace(url, workspaceRef.current), []);
  const [step, setStep] = useState("waiting");
  const [authData, setAuthData] = useState(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [error, setError] = useState(null);
  const [isDeviceCode, setIsDeviceCode] = useState(false);
  const [deviceData, setDeviceData] = useState(null);
  const [polling, setPolling] = useState(false);
  const [authMode, setAuthMode] = useState("browser"); // browser | paste-token
  const [pasteToken, setPasteToken] = useState("");
  const [ideStatus, setIdeStatus] = useState(null);
  const [isLocalhost, setIsLocalhost] = useState(false);
  const [placeholderUrl, setPlaceholderUrl] = useState("/callback?code=...");
  const popupRef = useRef(null);
  const pollingAbortRef = useRef(false);
  const openedRef = useRef(false);
  const callbackProcessedRef = useRef(false);
  // Proxy ledger: which proxy THIS session started and whether stop was sent.
  const flowRef = useRef(emptyLedger());
  // Parent callbacks live in refs so fresh inline closures don't re-run effects.
  const onSuccessRef = useRef(onSuccess);
  const onCloseRef = useRef(onClose);
  const isOpenRef = useRef(isOpen);
  const authModeRef = useRef(authMode);
  const startOAuthFlowRef = useRef(null);
  const { copied, error: copyError, copy } = useCopyToClipboard();

  useEffect(() => {
    setIsLocalhost(isLocalhostHostname(window.location.hostname));
    setPlaceholderUrl(`${window.location.origin}/callback?code=...`);
  }, []);

  const succeed = useCallback(() => {
    setStep("success");
    onSuccessRef.current?.();
  }, []);

  const fail = useCallback((message) => {
    setError(message);
    setStep("error");
  }, []);

  const exchangeTokens = useCallback(
    async (code, state) => {
      if (!authData) return;
      try {
        await postJson(ws(`/api/oauth/${provider}/exchange`), {
          code,
          redirectUri: authData.redirectUri,
          codeVerifier: authData.codeVerifier,
          state,
          // Zed: keep the system_id sent to zed.dev with the stored connection.
          ...(authData.systemId ? { systemId: authData.systemId } : {}),
          ...(oauthMeta ? { meta: oauthMeta } : {}),
        });
        if (flowCancelled(isOpenRef)) return;
        succeed();
      } catch (err) {
        if (flowCancelled(isOpenRef)) return;
        fail(err.message);
      }
    },
    [authData, provider, oauthMeta, succeed, fail, ws],
  );

  const completeXaiManualCode = useCallback(
    async (code) => {
      if (!authData?.state) return;
      try {
        await postJson(ws("/api/oauth/xai/manual-code"), { code, state: authData.state });
        if (flowCancelled(isOpenRef)) return;
        succeed();
      } catch (err) {
        if (flowCancelled(isOpenRef)) return;
        fail(err.message);
      }
    },
    [authData, succeed, fail, ws],
  );

  const startPolling = useCallback(
    async (deviceCode, codeVerifier, initialInterval, extraData, timeoutMs) => {
      // A stale start (closed mid-flight) must not re-arm polling: the close
      // effect already set pollingAbortRef, and it owns cleanup now.
      if (flowCancelled(isOpenRef) || pollingAbortRef.current) return;
      pollingAbortRef.current = false;
      setPolling(true);
      let interval = initialInterval;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pollingAbortRef.current || flowCancelled(isOpenRef)) {
          setPolling(false);
          return;
        }
        await new Promise((r) => setTimeout(r, interval * 1000));
        if (pollingAbortRef.current || flowCancelled(isOpenRef)) {
          setPolling(false);
          return;
        }
        try {
          const res = await fetch(ws(`/api/oauth/${provider}/poll`), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceCode, codeVerifier, extraData }),
          });
          if (flowCancelled(isOpenRef)) {
            setPolling(false);
            return;
          }
          const result = classifyDevicePoll(await res.json());
          if (result.kind === "done") {
            pollingAbortRef.current = true;
            setPolling(false);
            succeed();
            return;
          }
          if (result.kind === "fatal") throw new Error(result.message);
          interval = nextDevicePollInterval(interval, result.kind === "slow-down");
        } catch (err) {
          setPolling(false);
          if (flowCancelled(isOpenRef)) return;
          fail(err.message);
          return;
        }
      }
      setPolling(false);
      if (flowCancelled(isOpenRef)) return;
      fail("Authorization timeout");
    },
    [provider, succeed, fail, ws],
  );

  // Stop the proxy owned by THIS session, at most once.
  const stopOwnedProxy = useCallback(() => {
    const flow = flowRef.current;
    if (flow.proxyStarted && !flow.stopSent && flow.proxyProvider) {
      flow.stopSent = true;
      fetch(ws(`/api/oauth/${flow.proxyProvider}/stop-proxy`)).catch(() => {});
    }
  }, [ws]);

  const openPopup = useCallback((url) => {
    setStep("waiting");
    popupRef.current = window.open(url, "oauth_popup", POPUP_FEATURES);
    if (!popupRef.current) setStep("input"); // popup blocked: manual paste
  }, []);

  // Trae/Windsurf/Zed: dynamic-port local callback then auto exchange.
  const startProxyFlow = useCallback(
    async (providerId) => {
      const startRes = await fetch(ws(`/api/oauth/${providerId}/start-proxy`));
      const startData = await startRes.json();
      if (!startRes.ok || !startData.success || !startData.callbackUrl) {
        throw new Error(
          startData.reason || startData.error || `Failed to start ${providerId} callback server`,
        );
      }
      flowRef.current = { proxyStarted: true, proxyProvider: providerId, stopSent: false };
      if (!isOpenRef.current) {
        stopOwnedProxy();
        return;
      }
      const authorizeUrl = new URL(`/api/oauth/${providerId}/authorize`, window.location.origin);
      authorizeUrl.searchParams.set("redirect_uri", startData.callbackUrl);
      const authRes = await fetch(ws(authorizeUrl.toString()));
      const data = await authRes.json();
      if (!authRes.ok) {
        stopOwnedProxy();
        throw new Error(data.error);
      }
      if (!isOpenRef.current) {
        stopOwnedProxy();
        return;
      }
      // Secrets go in the POST body so they never land in URL/query logs.
      const regRes = await fetch(ws(`/api/oauth/${providerId}/register-session`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildProxyRegisterBody(data)),
      });
      let regData = null;
      try {
        regData = await regRes.json();
      } catch {
        regData = null;
      }
      if (!regRes.ok || regData?.success === false) {
        stopOwnedProxy();
        throw new Error(regData?.error || "Failed to register login session; please retry");
      }
      if (!isOpenRef.current) return; // close effect owns cleanup now
      setAuthData({ ...data, proxyProvider: providerId });
      openPopup(data.authUrl);
    },
    [stopOwnedProxy, openPopup, ws],
  );

  const startDeviceFlow = async () => {
    setIsDeviceCode(true);
    setStep("waiting");
    const deviceCodeUrl = new URL(`/api/oauth/${provider}/device-code`, window.location.origin);
    if (provider === "kiro" && idcConfig?.startUrl) {
      deviceCodeUrl.searchParams.set("start_url", idcConfig.startUrl);
      if (idcConfig.region) deviceCodeUrl.searchParams.set("region", idcConfig.region);
      deviceCodeUrl.searchParams.set("auth_method", "idc");
    }
    const res = await fetch(ws(deviceCodeUrl.toString()));
    if (flowCancelled(isOpenRef)) return; // close effect owns cleanup now
    const data = await res.json();
    if (flowCancelled(isOpenRef)) return;
    if (!res.ok) throw new Error(data.error);
    setDeviceData(data);
    const verifyUrl = data.verification_uri_complete || data.verification_uri;
    if (verifyUrl) window.open(verifyUrl, "_blank", "noopener,noreferrer");
    startPolling(
      data.device_code,
      data.codeVerifier,
      data.interval || 5,
      buildDeviceExtraData(provider, data),
      devicePollTimeoutMs(data.expires_in),
    );
  };

  const startAuthCodeFlow = async () => {
    const { port, protocol } = window.location;
    const appPort = port || (protocol === "https:" ? "443" : "80");
    const redirectUri = buildRedirectUri(provider, port, protocol);
    const authorizeUrl = new URL(`/api/oauth/${provider}/authorize`, window.location.origin);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    if (oauthMeta) {
      for (const [k, v] of Object.entries(oauthMeta)) {
        if (v) authorizeUrl.searchParams.set(k, v);
      }
    }
    const res = await fetch(ws(authorizeUrl.toString()));
    if (flowCancelled(isOpenRef)) return; // close effect owns cleanup now
    const data = await res.json();
    if (flowCancelled(isOpenRef)) return;
    if (!res.ok) throw new Error(data.error);

    let proxy = { active: false, serverSide: false };
    if (provider === "codex") {
      try {
        proxy = await startFixedPortProxy(
          "codex",
          appPort,
          data,
          redirectUri,
          workspaceRef.current,
        );
      } catch {
        proxy = { active: false, serverSide: false };
      }
    } else if (provider === "xai") {
      try {
        proxy = await startFixedPortProxy("xai", appPort, data, redirectUri, workspaceRef.current);
      } catch (e) {
        if (e?.message) throw e;
        proxy = { active: false, serverSide: false };
      }
      if (!proxy.active && proxy.reason === "port_busy") {
        throw new Error("Port 56121 in use; close the conflicting process and retry");
      }
    }

    if (flowCancelled(isOpenRef)) {
      // A fixed-port proxy may already run: arm the ledger first so the
      // close effect (which owns cleanup now) stops exactly what we started.
      if (proxy.active) {
        flowRef.current = { proxyStarted: true, proxyProvider: provider, stopSent: false };
      }
      stopOwnedProxy();
      return;
    }
    setAuthData({
      ...data,
      redirectUri,
      codexServerSide: provider === "codex" && proxy.serverSide,
      xaiServerSide: provider === "xai" && proxy.serverSide,
    });
    if (proxy.active) {
      flowRef.current = { proxyStarted: true, proxyProvider: provider, stopSent: false };
    }

    // device_code providers return authUrl:null; never window.open(null).
    if (!data.authUrl) {
      if (data.flowType === "device_code") {
        throw new Error(
          `Provider ${provider} uses device-code login but is not wired in the OAuth modal device-code list`,
        );
      }
      throw new Error("No authorization URL returned from OAuth provider");
    }

    const fixedPort = provider === "codex" || provider === "xai";
    if ((fixedPort && proxy.active) || (isLocalhost && !fixedPort)) {
      openPopup(data.authUrl);
    } else {
      setStep("input");
      window.open(data.authUrl, "_blank");
    }
  };

  // Plain function on purpose: memoizing would re-trigger effects on every parent render.
  // `mode` beats state: open/reset and the browser tab set the mode before React re-renders.
  const startOAuthFlow = async (mode = authModeRef.current) => {
    if (!provider) return;
    if (hostOnly && mode === "browser" && !DEVICE_CODE_PROVIDERS.has(provider)) {
      fail(
        "Browser callback sign-in must start on the gateway host. Use a device-code flow or paste credentials where supported, or ask the workspace owner to connect this account.",
      );
      return;
    }
    try {
      // Re-arm the poll: it runs before the callback listener that also clears this.
      callbackProcessedRef.current = false;
      setError(null);
      if (PROXY_OAUTH_PROVIDERS.has(provider) && mode === "browser") {
        await startProxyFlow(provider);
      } else if (DEVICE_CODE_PROVIDERS.has(provider)) {
        await startDeviceFlow();
      } else {
        await startAuthCodeFlow();
      }
    } catch (err) {
      if (flowCancelled(isOpenRef)) return;
      fail(err.message);
    }
  };

  useEffect(() => {
    onSuccessRef.current = onSuccess;
    onCloseRef.current = onClose;
    isOpenRef.current = isOpen;
    authModeRef.current = authMode;
    startOAuthFlowRef.current = startOAuthFlow;
  });

  // Reset and start exactly once per open (StrictMode re-runs never open extra tabs).
  useEffect(() => {
    if (!isOpen || !provider || !remoteReady) return;
    if (openedRef.current) return;
    openedRef.current = true;
    setAuthData(null);
    setCallbackUrl("");
    setError(null);
    setIsDeviceCode(false);
    setDeviceData(null);
    setPolling(false);
    callbackProcessedRef.current = false;
    // Ref first: start runs in this effect, before the browser-mode setState commits.
    authModeRef.current = "browser";
    setAuthMode("browser");
    setPasteToken("");
    setIdeStatus(null);
    pollingAbortRef.current = false;
    flowRef.current = emptyLedger();
    if (PASTE_TOKEN_PROVIDERS[provider] && !hostOnly) {
      fetch(ws(`/api/oauth/${provider}/ide-status`))
        .then((r) => r.json())
        .then((data) => setIdeStatus(data))
        .catch(() => setIdeStatus({ installed: false, path: null }));
    }
    startOAuthFlowRef.current("browser");
  }, [isOpen, provider, ws, remoteReady, hostOnly]);

  // On close: abort polling and stop the owned proxy exactly once. Mark the
  // callback consumed and drop authData so the proxy-status and callback
  // listeners can no longer succeed() after close.
  useEffect(() => {
    if (isOpen) return;
    pollingAbortRef.current = true;
    openedRef.current = false;
    callbackProcessedRef.current = true;
    setAuthData(null);
    stopOwnedProxy();
    flowRef.current = emptyLedger();
  }, [isOpen, stopOwnedProxy]);

  // Cleanup on unmount: wrappers (Cursor/Kiro/GitLab) unmount this modal while
  // isOpen stays true, so the close effect above never fires. Abort polling and
  // stop any owned proxy so no orphaned loop can fire a stale onSuccess.
  // openedRef is intentionally untouched so StrictMode remounts don't re-open.
  useEffect(() => {
    return () => {
      pollingAbortRef.current = true;
      stopOwnedProxy();
    };
  }, [stopOwnedProxy]);

  useOAuthProxyStatus({
    workspaceId,
    isOpen,
    authData,
    callbackProcessedRef,
    onSuccessRef,
    setError,
    setStep,
  });
  useOAuthCallbackListener({ authData, callbackProcessedRef, exchangeTokens, setError, setStep });

  const handleManualSubmit = async () => {
    try {
      setError(null);
      if (authMode === "paste-token" && PASTE_TOKEN_PROVIDERS[provider]) {
        const token = pasteToken.trim();
        if (!token) throw new Error("Missing token");
        await postJson(ws(`/api/oauth/${provider}/exchange`), { code: token });
        succeed();
        return;
      }
      const parsed = parseManualCallback(provider, callbackUrl.trim());
      if (parsed.kind === "error") throw new Error(parsed.message);
      if (parsed.kind === "proxy-manual") {
        // Popup blocked or unreachable 127.0.0.1: same attempt material as the auto path.
        await postJson(ws(`/api/oauth/${provider}/exchange`), {
          code: parsed.code,
          state: authData?.state,
          ...(authData?.redirectUri ? { redirectUri: authData.redirectUri } : {}),
          ...(authData?.codeVerifier ? { codeVerifier: authData.codeVerifier } : {}),
          ...(authData?.systemId ? { systemId: authData.systemId } : {}),
        });
        callbackProcessedRef.current = true; // stop poll-status
        stopOwnedProxy();
        succeed();
        return;
      }
      if (parsed.kind === "xai-manual") {
        await completeXaiManualCode(parsed.code);
        return;
      }
      await exchangeTokens(parsed.code, parsed.state);
    } catch (err) {
      if (flowCancelled(isOpenRef)) return;
      fail(err.message);
    }
  };

  // Every close path (button, Esc, backdrop) funnels here; proxy stop is idempotent.
  const handleClose = useCallback(() => {
    pollingAbortRef.current = true;
    stopOwnedProxy();
    onCloseRef.current();
  }, [stopOwnedProxy]);

  const selectBrowserMode = () => {
    authModeRef.current = "browser";
    setAuthMode("browser");
    setError(null);
    setStep("waiting");
    startOAuthFlow("browser");
  };

  const selectPasteTokenMode = () => {
    authModeRef.current = "paste-token";
    setAuthMode("paste-token");
    setError(null);
    setStep("input");
  };

  return {
    step,
    authData,
    callbackUrl,
    setCallbackUrl,
    error,
    isDeviceCode,
    deviceData,
    polling,
    authMode,
    pasteToken,
    setPasteToken,
    ideStatus,
    placeholderUrl,
    copied,
    copyError,
    copy,
    startOAuthFlow,
    handleManualSubmit,
    handleClose,
    selectBrowserMode,
    selectPasteTokenMode,
  };
}
