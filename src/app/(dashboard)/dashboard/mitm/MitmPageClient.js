"use client";

import { useState, useEffect } from "react";
import { MITM_TOOLS } from "@/shared/constants/cliTools";
import { getModelsByProviderId } from "@/shared/constants/models";
import {
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
} from "@/shared/constants/providers";
import { MitmServerCard, MitmToolCard } from "@/app/(dashboard)/dashboard/cli-tools/components";
import { Callout } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { useCliAccessStore } from "@/store/cliAccessStore";
import LocalOnlyNotice from "@/app/(dashboard)/dashboard/cli-tools/components/LocalOnlyNotice";

/**
 * MITM setup page shell: page-owned risk warning plus the shared server card
 * and per-tool DNS cards (owned by the CLI-tools redesign). Parity: provider,
 * key, alias and settings fetches; running/cert/DNS status; one expanded tool.
 */
export default function MitmPageClient() {
  const [connections, setConnections] = useState([]);
  const [apiKeys, setApiKeys] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [expandedTool, setExpandedTool] = useState(null);
  const localOnly = useCliAccessStore((s) => s.localOnly);
  const [mitmStatus, setMitmStatus] = useState({
    running: false,
    certExists: false,
    dnsStatus: {},
    hasCachedPassword: false,
  });
  // Independent reads keep the other MITM controls usable when one endpoint fails.
  useEffect(() => {
    let cancelled = false;
    const load = async (url, label, apply, fallback) => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) apply(data);
      } catch {
        if (!cancelled) {
          apply(fallback);
          useNotificationStore
            .getState()
            .error(`Couldn't load ${label}. MITM options may be incomplete.`);
        }
      }
    };
    load("/api/providers", "providers", (data) => setConnections(data.connections || []), {});
    load("/api/keys", "API keys", (data) => setApiKeys(data.keys || []), {});
    load("/api/models/alias", "model aliases", (data) => setModelAliases(data.aliases || {}), {});
    load(
      "/api/settings",
      "cloud settings",
      (data) => setCloudEnabled(data.cloudEnabled || false),
      {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const getActiveProviders = () => connections.filter((c) => c.isActive !== false);

  const hasActiveProviders = () => {
    const active = getActiveProviders();
    return active.some(
      (conn) =>
        getModelsByProviderId(conn.provider).length > 0 ||
        isOpenAICompatibleProvider(conn.provider) ||
        isAnthropicCompatibleProvider(conn.provider),
    );
  };

  const mitmTools = Object.entries(MITM_TOOLS);

  return (
    <div className="flex w-full flex-col gap-5">
      <Callout variant="warn" title="MITM intercepts HTTPS traffic of IDE tools">
        Antigravity, GitHub Copilot and Kiro requests are redirected via a local CA to your
        providers. This may violate their terms of service and risk an account ban. Use at your own
        risk.
      </Callout>

      {/* MITM server Card: its status GET is what detects local-only access */}
      {localOnly ? (
        <LocalOnlyNotice />
      ) : (
        <MitmServerCard
          apiKeys={apiKeys}
          cloudEnabled={cloudEnabled}
          onStatusChange={setMitmStatus}
        />
      )}

      {/* Tool Cards */}
      <div className="grid gap-4">
        {!localOnly &&
          mitmTools.map(([toolId, tool]) => (
            <MitmToolCard
              key={toolId}
              tool={tool}
              isExpanded={expandedTool === toolId}
              onToggle={() => setExpandedTool(expandedTool === toolId ? null : toolId)}
              serverRunning={mitmStatus.running}
              dnsActive={mitmStatus.dnsStatus?.[toolId] || false}
              hasCachedPassword={mitmStatus.hasCachedPassword || false}
              needsSudoPassword={mitmStatus.needsSudoPassword !== false}
              isWin={mitmStatus.isWin === true}
              apiKeys={apiKeys}
              activeProviders={getActiveProviders()}
              hasActiveProviders={hasActiveProviders()}
              modelAliases={modelAliases}
              cloudEnabled={cloudEnabled}
              onDnsChange={(data) =>
                setMitmStatus((prev) => ({ ...prev, dnsStatus: data.dnsStatus ?? prev.dnsStatus }))
              }
            />
          ))}
      </div>
    </div>
  );
}
