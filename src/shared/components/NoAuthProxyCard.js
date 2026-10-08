"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import Card from "./Card";
import Select from "./Select";
import Badge from "./Badge";
import { useSettingsScope } from "@/shared/hooks/useSettingsScope";
import { loadSettingsValue, patchSettings } from "@/shared/utils/settingsApi";

const NONE_PROXY_POOL_VALUE = "__none__";
const STRATEGIES = [
  { value: "none", label: "None (single pool)" },
  { value: "round-robin", label: "Round-robin" },
  { value: "random", label: "Random" },
];

export default function NoAuthProxyCard({ providerId }) {
  const [proxyPools, setProxyPools] = useState([]);
  const [proxyPoolId, setProxyPoolId] = useState(NONE_PROXY_POOL_VALUE);
  const [rotateStrategy, setRotateStrategy] = useState("none");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  // Controls stay disabled until the current override is known: saving from
  // a guessed default would drop the other field's stored value.
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const { ready, scope } = useSettingsScope();

  useEffect(() => {
    if (!ready) return undefined;
    let cancelled = false;
    Promise.all([
      fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }).then((r) =>
        r.ok ? r.json() : { proxyPools: [] },
      ),
      // YAN-749: providerStrategies is a workspace key.
      loadSettingsValue("providerStrategies", scope),
    ])
      .then(([poolData, strategies]) => {
        if (cancelled) return;
        setProxyPools(poolData.proxyPools || []);
        const override = strategies?.[providerId] || {};
        setProxyPoolId(override.proxyPoolId || NONE_PROXY_POOL_VALUE);
        setRotateStrategy(override.rotateStrategy || "none");
        setLoaded(true);
        setLoadError("");
      })
      .catch(() => {
        if (!cancelled) setLoadError("Could not load the proxy settings. Reload to try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [providerId, ready, scope]);

  const save = useCallback(
    async (poolId, strategy) => {
      setSaving(true);
      try {
        // Read-modify-write: a failed read throws instead of PATCHing over
        // every other provider's strategy with `{}`.
        const current = (await loadSettingsValue("providerStrategies", scope)) || {};
        const override = { ...(current[providerId] || {}) };
        if (poolId === NONE_PROXY_POOL_VALUE) delete override.proxyPoolId;
        else override.proxyPoolId = poolId;
        if (strategy === "none") delete override.rotateStrategy;
        else override.rotateStrategy = strategy;
        const updated = { ...current };
        if (Object.keys(override).length === 0) delete updated[providerId];
        else updated[providerId] = override;
        await patchSettings({ providerStrategies: updated }, scope);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1500);
      } catch (e) {
        console.log("Save proxy config error:", e);
      } finally {
        setSaving(false);
      }
    },
    [providerId, scope],
  );

  const handlePoolChange = (newPoolId) => {
    setProxyPoolId(newPoolId);
    save(newPoolId, rotateStrategy);
  };

  const handleStrategyChange = (newStrategy) => {
    setRotateStrategy(newStrategy);
    save(proxyPoolId, newStrategy);
  };

  const canRotate = proxyPools.length >= 2;
  const isRotation = rotateStrategy !== "none";

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-ok-bg text-ok">
          <span className="material-symbols-outlined text-[20px]">lock_open</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">No authentication required</p>
          <p className="text-xs text-muted">
            This provider is ready to use. Optionally route requests through a proxy pool to bypass
            IP-based limits.
          </p>
        </div>
        {savedFlash && (
          <Badge variant="success" size="sm">
            Saved
          </Badge>
        )}
      </div>

      <Select
        label="Proxy pool"
        value={proxyPoolId}
        onChange={(e) => handlePoolChange(e.target.value)}
        disabled={saving || !loaded || isRotation}
        options={[
          { value: NONE_PROXY_POOL_VALUE, label: "None (direct)" },
          ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
        ]}
        hint={
          isRotation
            ? "Pool selector is ignored when rotation is active — all active pools are used."
            : undefined
        }
      />

      <div className="flex flex-col gap-2 mt-4">
        <label className="text-sm font-medium text-text">Rotation strategy</label>
        <select
          value={rotateStrategy}
          onChange={(e) => handleStrategyChange(e.target.value)}
          disabled={saving || !loaded}
          className="py-2 px-3 text-sm text-text bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-coral/30 focus:border-coral/50 focus:outline-none transition-all disabled:opacity-50"
        >
          {STRATEGIES.map((s) => (
            <option key={s.value} value={s.value} disabled={s.value !== "none" && !canRotate}>
              {s.label}
            </option>
          ))}
        </select>
        {loadError && (
          <p role="alert" className="text-xs text-err">
            {loadError}
          </p>
        )}
        <p className="text-xs text-muted">
          {!canRotate
            ? `Need at least 2 active proxy pools for rotation.`
            : isRotation
              ? rotateStrategy === "round-robin"
                ? `Rotating through all ${proxyPools.length} active pools in order. State is in-memory (resets on restart).`
                : `Picking a random pool from ${proxyPools.length} active pools each request.`
              : `Uses the selected pool above. Set to Round-robin or Random to rotate across all active pools.`}
        </p>
      </div>
    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
