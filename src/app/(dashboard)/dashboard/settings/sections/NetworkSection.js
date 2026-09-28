"use client";

import PropTypes from "prop-types";
import { useCallback, useEffect, useState } from "react";
import SectionCard from "@/shared/components/SectionCard";
import SettingRow from "@/shared/components/SettingRow";
import Toggle from "@/shared/components/Toggle";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Callout from "@/shared/components/Callout";
import StatusPill from "@/shared/components/StatusPill";
import { useSettingsField } from "../useSettingsField";
import {
  tailscaleDisplay,
  tailscaleGateReason,
  tunnelDisplay,
  tunnelGateReason,
} from "./networkUtils";

/** SEARXNG fallback when the env var is unset (open-sse/config/runtimeConfig.js). */
const SEARXNG_FALLBACK = "http://localhost:8888/search";

/**
 * Fetch tunnel + tailscale probes. Mirrors the Endpoint page's
 * `/api/tunnel/status` shape ({ tunnel, tailscale }).
 * @returns {Promise<{ tunnel: object|null, tailscale: object|null }>}
 */
async function fetchTunnelStatus() {
  const res = await fetch("/api/tunnel/status", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return { tunnel: data.tunnel ?? null, tailscale: data.tailscale ?? null };
}

/**
 * Network section: outbound proxy (toggle, URL, no-proxy, test/apply),
 * Cloudflare tunnel and Tailscale status + toggles through the same
 * endpoints as the Endpoint page (`/api/tunnel/*`), read-only tunnel
 * provider + SearXNG URL, and a link to Proxy pools.
 * @param {{ settings: Record<string, unknown>, onSettingsChange?: (patch: Record<string, unknown>) => void }} props
 */
export default function NetworkSection({ settings, onSettingsChange }) {
  const onSaved = (key) => (value) => onSettingsChange?.({ [key]: value });
  const proxyEnabledField = useSettingsField(
    "outboundProxyEnabled",
    settings.outboundProxyEnabled === true,
    { onSaved: onSaved("outboundProxyEnabled") },
  );
  const proxyUrlField = useSettingsField("outboundProxyUrl", settings.outboundProxyUrl ?? "", {
    debounced: true,
    onSaved: onSaved("outboundProxyUrl"),
  });
  const noProxyField = useSettingsField("outboundNoProxy", settings.outboundNoProxy ?? "", {
    debounced: true,
    onSaved: onSaved("outboundNoProxy"),
  });

  const [proxyStatus, setProxyStatus] = useState({ type: "", message: "" });
  const [proxyLoading, setProxyLoading] = useState(false);
  const [applyLoading, setApplyLoading] = useState(false);

  const [netStatus, setNetStatus] = useState({ tunnel: null, tailscale: null });
  const [netLoading, setNetLoading] = useState(true);
  const [netError, setNetError] = useState("");
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [tailscaleBusy, setTailscaleBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const loadNetStatus = useCallback(async () => {
    setNetLoading(true);
    setNetError("");
    try {
      setNetStatus(await fetchTunnelStatus());
    } catch {
      setNetError("Could not load tunnel status");
    } finally {
      setNetLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNetStatus();
  }, [loadNetStatus]);

  const handleTestProxy = async () => {
    setProxyLoading(true);
    setProxyStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings/proxy-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyUrl: proxyUrlField.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok !== false) {
        const ms = typeof data.elapsedMs === "number" ? ` · ${data.elapsedMs}ms` : "";
        setProxyStatus({ type: "ok", message: `Reachable${ms}` });
      } else {
        setProxyStatus({ type: "err", message: data.error || "Proxy test failed" });
      }
    } catch {
      setProxyStatus({ type: "err", message: "Proxy test failed" });
    } finally {
      setProxyLoading(false);
    }
  };

  // PATCH the three proxy keys; the API applies them without restart.
  const handleApplyProxy = async () => {
    setApplyLoading(true);
    setProxyStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outboundProxyEnabled: proxyEnabledField.value,
          outboundProxyUrl: proxyUrlField.value,
          outboundNoProxy: noProxyField.value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to apply proxy settings");
      onSettingsChange?.({
        outboundProxyEnabled: data.outboundProxyEnabled,
        outboundProxyUrl: data.outboundProxyUrl,
        outboundNoProxy: data.outboundNoProxy,
      });
      setProxyStatus({ type: "ok", message: "Proxy settings applied" });
    } catch (err) {
      setProxyStatus({ type: "err", message: err.message || "Failed to apply proxy settings" });
    } finally {
      setApplyLoading(false);
    }
  };

  const handleTunnelToggle = async (next) => {
    setActionError("");
    setTunnelBusy(true);
    try {
      const res = await fetch(next ? "/api/tunnel/enable" : "/api/tunnel/disable", {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to update tunnel");
      onSettingsChange?.({ tunnelEnabled: next });
      await loadNetStatus();
    } catch (err) {
      setActionError(err.message || "Failed to update tunnel");
    } finally {
      setTunnelBusy(false);
    }
  };

  const handleTailscaleToggle = async (next) => {
    setActionError("");
    setTailscaleBusy(true);
    try {
      const res = await fetch(
        next ? "/api/tunnel/tailscale-enable" : "/api/tunnel/tailscale-disable",
        { method: "POST" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to update Tailscale");
      onSettingsChange?.({ tailscaleEnabled: next });
      await loadNetStatus();
    } catch (err) {
      setActionError(err.message || "Failed to update Tailscale");
    } finally {
      setTailscaleBusy(false);
    }
  };

  const tunnel = tunnelDisplay(netStatus.tunnel);
  const tailscale = tailscaleDisplay(netStatus.tailscale);
  const tunnelChecked = netStatus.tunnel?.settingsEnabled === true;
  const tailscaleChecked = netStatus.tailscale?.settingsEnabled === true;
  const tunnelGate = tunnelGateReason({
    requireLogin: settings.requireLogin !== false,
    hasPassword: settings.hasPassword === true,
    requireApiKey: settings.requireApiKey === true,
  });
  const tailscaleGate = tailscaleGateReason({
    requireLogin: settings.requireLogin !== false,
    hasPassword: settings.hasPassword === true,
  });
  const proxyError = proxyUrlField.error || noProxyField.error || proxyEnabledField.error;

  return (
    <div id="network" className="scroll-mt-24 space-y-4">
      <SectionCard
        icon="public"
        title="Network"
        subtitle="How 9router reaches providers, and how you reach it."
      />
      <div className="rounded-2xl border border-line bg-panel p-5 shadow-card divide-y divide-line">
        <SettingRow
          label="Outbound proxy"
          description="Send OAuth and provider calls through a proxy. Applies without restart."
          settingKey="outboundProxyEnabled"
          control={
            <Toggle
              checked={proxyEnabledField.value}
              onChange={(next) => proxyEnabledField.set(next)}
              disabled={proxyEnabledField.saving}
              aria-label="Outbound proxy"
            />
          }
        />

        <div className="py-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Proxy URL"
              value={proxyUrlField.value ?? ""}
              onChange={(e) => proxyUrlField.set(e.target.value)}
              placeholder="http://127.0.0.1:7897"
              inputClassName="font-mono"
            />
            <Input
              label="Skip for"
              value={noProxyField.value ?? ""}
              onChange={(e) => noProxyField.set(e.target.value)}
              placeholder="localhost, .internal"
              inputClassName="font-mono"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleTestProxy}
              loading={proxyLoading}
              disabled={!proxyUrlField.value?.trim?.()}
            >
              Test proxy
            </Button>
            <Button size="sm" onClick={handleApplyProxy} loading={applyLoading}>
              Apply
            </Button>
            {proxyStatus.message && (
              <StatusPill variant={proxyStatus.type === "ok" ? "ok" : "err"} size="sm" dot>
                {proxyStatus.message}
              </StatusPill>
            )}
          </div>
          {proxyError && (
            <p className="text-xs text-err" role="alert">
              {proxyError}
            </p>
          )}
          <div aria-live="polite" aria-atomic="true" className="sr-only">
            {proxyStatus.message || proxyError}
          </div>
        </div>

        <SettingRow
          label="Cloudflare tunnel"
          description={
            netLoading
              ? "Checking status…"
              : netStatus.tunnel?.publicUrl || netStatus.tunnel?.tunnelUrl
                ? `Public HTTPS URL: ${netStatus.tunnel.publicUrl || netStatus.tunnel.tunnelUrl}`
                : "Public HTTPS URL. Needs Require API key."
          }
          settingKey="tunnelEnabled"
          control={
            <div className="flex items-center gap-2">
              {!netLoading && !netError && (
                <StatusPill variant={tunnel.variant} size="sm" dot>
                  {tunnel.label}
                </StatusPill>
              )}
              <Toggle
                checked={tunnelChecked}
                onChange={handleTunnelToggle}
                disabled={tunnelBusy || netLoading || Boolean(tunnelGate && !tunnelChecked)}
                title={tunnelGate && !tunnelChecked ? tunnelGate : undefined}
                aria-label="Cloudflare tunnel"
              />
            </div>
          }
        />
        {tunnelGate && !tunnelChecked && <p className="py-2 text-xs text-muted">{tunnelGate}</p>}

        <SettingRow
          label="Tailscale"
          description={
            netLoading
              ? "Checking status…"
              : netStatus.tailscale?.tunnelUrl || "Private mesh access."
          }
          settingKey="tailscaleEnabled"
          control={
            <div className="flex items-center gap-2">
              {!netLoading && !netError && (
                <StatusPill variant={tailscale.variant} size="sm" dot>
                  {tailscale.label}
                </StatusPill>
              )}
              <Toggle
                checked={tailscaleChecked}
                onChange={handleTailscaleToggle}
                disabled={
                  tailscaleBusy || netLoading || Boolean(tailscaleGate && !tailscaleChecked)
                }
                title={tailscaleGate && !tailscaleChecked ? tailscaleGate : undefined}
                aria-label="Tailscale"
              />
            </div>
          }
        />
        {tailscaleGate && !tailscaleChecked && (
          <p className="py-2 text-xs text-muted">{tailscaleGate}</p>
        )}
        {(netError || actionError) && (
          <Callout variant="err" title={actionError || netError}>
            {!actionError && (
              <Button variant="ghost" size="sm" onClick={loadNetStatus}>
                Retry
              </Button>
            )}
          </Callout>
        )}

        <SettingRow
          label="Tunnel provider"
          description="Active tunnel backend."
          settingKey="tunnelProvider"
          control={
            <span className="font-mono text-[13px] text-muted">
              {typeof settings.tunnelProvider === "string" && settings.tunnelProvider
                ? settings.tunnelProvider
                : "cloudflare"}
            </span>
          }
        />
        <SettingRow
          label="Web search backend"
          description="SearXNG instance used by web search. Set SEARXNG_URL in .env and restart to change."
          settingKey="SEARXNG_URL"
          control={
            <span className="font-mono text-[13px] text-muted">
              {typeof settings.searxngUrl === "string" && settings.searxngUrl
                ? settings.searxngUrl
                : `not set (default ${SEARXNG_FALLBACK})`}
            </span>
          }
        />

        <div className="pt-4">
          <Button variant="ghost" size="sm" href="/dashboard/proxy-pools" iconRight="arrow_forward">
            Per-connection proxies and relays live in Proxy pools
          </Button>
        </div>
      </div>
    </div>
  );
}

NetworkSection.propTypes = {
  settings: PropTypes.object.isRequired,
  onSettingsChange: PropTypes.func,
};
