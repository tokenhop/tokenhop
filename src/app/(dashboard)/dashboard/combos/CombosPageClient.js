"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Button,
  CardSkeleton,
  ComboFormModal,
  ConfirmModal,
  SectionCard,
  EmptyState,
} from "@/shared/components";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import ComboListCard from "@/shared/components/combos/ComboListCard";
import ComboEditor from "@/shared/components/combos/ComboEditor";
import CapabilityAdapterCard from "@/shared/components/combos/CapabilityAdapterCard";
import {
  STRATEGIES,
  STRATEGY_PILL,
  usageTodayForCombo,
} from "@/shared/components/combos/comboBuilder";

// Valid capability-adapter pools. pdf / videoInput stay hidden until the
// translator supports those blocks.
const CAPACITY_ADAPTER_CAPS = ["vision", "audioInput"];
const EMPTY_CAP_ENTRY = { enabled: true, roundRobin: false, models: [] };

/**
 * Combos URL with `combo` and/or `create` changed. Other params and the hash
 * are preserved; `undefined` leaves a key untouched, `null`/`false` removes it.
 * @param {string} search `location.search` plus optional `location.hash`
 * @param {{combo?: string|null, create?: boolean}} changes
 */
export function comboHref(search, changes) {
  const raw = search || "";
  const hashIndex = raw.indexOf("#");
  const params = new URLSearchParams(hashIndex === -1 ? raw : raw.slice(0, hashIndex));
  const hash = hashIndex === -1 ? "" : raw.slice(hashIndex);
  if (changes.combo !== undefined) {
    if (changes.combo) params.set("combo", changes.combo);
    else params.delete("combo");
  }
  if (changes.create !== undefined) {
    if (changes.create) params.set("create", "1");
    else params.delete("create");
  }
  const query = params.toString();
  return `${query ? `/dashboard/combos?${query}` : "/dashboard/combos"}${hash}`;
}

/**
 * Every combos URL change goes through the App Router — never raw history —
 * so useSearchParams, Back/Forward and in-flight navigations stay in one
 * consistent history. Skips no-op navigations.
 */
function navigateCombos(router, changes, method = "replace") {
  const current = `${window.location.search}${window.location.hash}`;
  const href = comboHref(current, changes);
  if (href === `${window.location.pathname}${current}`) return;
  if (method === "push") router.push(href, { scroll: false });
  else router.replace(href, { scroll: false });
}

/**
 * Pure URL-state helpers for the linkable ?combo=<id> / ?create=1 params.
 * Kept pure (no window) so they are unit-testable. Other params preserved
 * because callers only set/delete the one key they own.
 */
export function readComboSelection(search) {
  return new URLSearchParams(search || "").get("combo") || null;
}

export function readCreateRequested(search) {
  return new URLSearchParams(search || "").get("create") === "1";
}

/**
 * Pick the combo to select for a `?combo=` value: the requested id when it
 * exists, else the current selection when it still exists, else the first
 * combo, else null.
 * @param {string|null} requested
 * @param {Array<{id: string}>} combos
 * @param {string|null} current
 * @returns {string|null}
 */
export function resolveComboSelection(requested, combos, current) {
  const list = Array.isArray(combos) ? combos : [];
  if (requested && list.some((c) => c.id === requested)) return requested;
  if (current && list.some((c) => c.id === current)) return current;
  return list[0]?.id || null;
}

/** Legacy stored form was an array of {model, enabled}. */
export function normalizeCapEntry(entry) {
  if (Array.isArray(entry)) {
    return {
      enabled: true,
      roundRobin: false,
      models: entry.map((e) => e?.model || e).filter(Boolean),
    };
  }
  if (entry && typeof entry === "object") {
    return {
      enabled: entry.enabled !== false,
      roundRobin: !!entry.roundRobin,
      models: Array.isArray(entry.models) ? entry.models.filter(Boolean) : [],
    };
  }
  return { ...EMPTY_CAP_ENTRY };
}

function strategyOf(comboStrategies, name) {
  return comboStrategies?.[name]?.fallbackStrategy || "fallback";
}

function strategyLabelOf(id) {
  return STRATEGIES.find((s) => s.id === id)?.label || "Fallback";
}

/**
 * Combos route builder: list column (combo cards + capability adapter card)
 * and an editor card for the selected combo.
 */
export default function CombosPageClient() {
  const [combos, setCombos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [activeProviders, setActiveProviders] = useState([]);
  const [comboStrategies, setComboStrategies] = useState({});
  const [capacityAdapter, setCapacityAdapter] = useState({
    vision: { ...EMPTY_CAP_ENTRY },
    audioInput: { ...EMPTY_CAP_ENTRY },
  });
  const [usageToday, setUsageToday] = useState({});
  const [modelAliases, setModelAliases] = useState({});
  // Editor draft state lives here so Save/Delete/rename hit the real APIs.
  // draftModels/draftStrategy/draftWeights/draftJudge start from the selected
  // combo on selection and reset after every successful server round-trip.
  const [draftModels, setDraftModels] = useState(null);
  const [draftStrategy, setDraftStrategy] = useState("fallback");
  const [draftWeights, setDraftWeights] = useState({});
  const [draftJudge, setDraftJudge] = useState("");
  const [headroom, setHeadroom] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [adapterError, setAdapterError] = useState("");
  const [confirmState, setConfirmState] = useState(null);
  const { getCaps } = useModelCaps();
  const strategiesRef = useRef(comboStrategies);
  const saveQueueRef = useRef(Promise.resolve());

  useEffect(() => {
    strategiesRef.current = comboStrategies;
  }, [comboStrategies]);

  // URL is the source of truth. useSearchParams changes on same-route
  // router.push (the palette) and Back/Forward; Next keeps this page mounted
  // for search-only changes. Clicks navigate with router.push, so there is no
  // pushState/setState race for Next to reconcile behind the scenes.
  const searchParams = useSearchParams();
  const router = useRouter();
  const searchString = searchParams?.toString() ?? "";
  const navigate = (id, method) => navigateCombos(router, { combo: id }, method);
  const requestedComboId = readComboSelection(searchString);
  const createRequested = readCreateRequested(searchString);
  const requestedCombo = combos.some((c) => c.id === requestedComboId) ? requestedComboId : null;

  // Missing/invalid ?combo= falls back via navigation once the list is known.
  // navigate derives from router + location at call time so the effect does
  // not hold a stale closure over it. The last valid URL selection becomes the
  // fallback source, so a palette jump is never lost to a stale selectedId.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const lastValidSelectionRef = useRef(requestedCombo || selectedId);
  if (requestedCombo) lastValidSelectionRef.current = requestedCombo;
  const fallbackId = resolveComboSelection(
    null,
    combos,
    lastValidSelectionRef.current ?? selectedId,
  );
  const selectedComboId = requestedCombo || fallbackId;
  useEffect(() => {
    if (loading || loadError || createRequested) return;
    if (requestedComboId === fallbackId) return;
    navigateRef.current(fallbackId, "replace");
  }, [requestedComboId, fallbackId, createRequested, loading, loadError]);

  // ?create=1 opens the new-combo modal (also when the list is empty).
  useEffect(() => {
    setShowCreateModal(createRequested);
  }, [createRequested]);

  // User clicks get their own history entry so Back returns to the prior combo.
  const selectCombo = (id) => {
    if (id === selectedComboId) return;
    navigate(id, "push");
    setSelectedId(id);
  };
  const openCreate = () => {
    setShowCreateModal(true);
    navigateCombos(router, { create: true });
  };
  const closeCreate = () => {
    setShowCreateModal(false);
    navigateCombos(router, { create: false });
  };

  const fetchData = useCallback(async () => {
    setLoadError("");
    try {
      const [combosRes, providersRes, settingsRes, usageRes, aliasRes] = await Promise.all([
        fetch("/api/combos"),
        fetch("/api/providers"),
        fetch("/api/settings"),
        fetch("/api/usage/stats?period=today"),
        fetch("/api/models/alias"),
      ]);
      if (!combosRes.ok) throw new Error(`combos ${combosRes.status}`);
      const combosData = await combosRes.json();
      const providersData = providersRes.ok ? await providersRes.json() : {};
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      const usageData = usageRes.ok ? await usageRes.json() : {};
      const aliasData = aliasRes.ok ? await aliasRes.json() : {};

      // Only LLM combos here — webSearch/webFetch combos belong to media-providers/web.
      const list = (combosData.combos || []).filter((c) => !c.kind || c.kind === "llm");
      setCombos(list);
      // Selection derives from the URL on every render, so refetches only need
      // to keep a valid selectedId fallback for missing/invalid params.
      setSelectedId((prev) => resolveComboSelection(null, list, prev));
      setActiveProviders(providersData.connections || []);
      setComboStrategies(settingsData.comboStrategies || {});
      const rawAdapter = settingsData.capacityAdapter || {};
      const normalized = {};
      for (const key of CAPACITY_ADAPTER_CAPS) normalized[key] = normalizeCapEntry(rawAdapter[key]);
      setCapacityAdapter(normalized);
      const byModel = usageData.byModel || {};
      const today = {};
      for (const c of list) today[c.id] = usageTodayForCombo(c, byModel);
      setUsageToday(today);
      setModelAliases(aliasData.aliases || {});
    } catch (error) {
      setLoadError(error?.message || "Failed to load combos");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const selected = combos.find((c) => c.id === selectedComboId) || null;
  const selectedStrategy = selected ? strategyOf(comboStrategies, selected.name) : "fallback";

  // Seed the editor draft on selection change only. Server round-trips
  // (fetchData, weight/judge auto-saves) must never wipe unsaved edits:
  // Save flows re-seed explicitly via applyServerState below.
  const seededIdRef = useRef(null);
  const applyServerState = (combo, strategies) => {
    if (!combo) {
      setDraftModels(null);
      return;
    }
    setDraftModels(combo.models || []);
    setDraftStrategy(strategyOf(strategies, combo.name));
    setDraftWeights(strategies[combo.name]?.weights || {});
    setDraftJudge(strategies[combo.name]?.judgeModel || "");
    setSaveError("");
  };
  useEffect(() => {
    if (selected?.id === seededIdRef.current) return;
    seededIdRef.current = selected?.id || null;
    applyServerState(selected, strategiesRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  // Headroom re-fetches when models change; an effect-local cancelled flag
  // drops stale responses so an older request never overwrites a newer one.
  const selectedIdForHeadroom = selected?.id;
  useEffect(() => {
    if (!selectedIdForHeadroom || draftStrategy !== "weighted" || !draftModels?.length) {
      setHeadroom({});
      return;
    }
    let cancelled = false;
    fetch(`/api/combos/${selectedIdForHeadroom}/headroom`)
      .then((res) => (res.ok ? res.json() : {}))
      .then((data) => {
        if (!cancelled) setHeadroom(data.headroom || {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedIdForHeadroom, draftStrategy, draftModels]);

  const handleSetCapacityAdapter = async (next) => {
    const prev = capacityAdapter;
    setCapacityAdapter(next);
    setAdapterError("");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capacityAdapter: next }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `adapter save failed (${res.status})`);
      }
    } catch (error) {
      setCapacityAdapter(prev);
      setAdapterError(error?.message || "Failed to save adapter");
    }
  };

  const handleCreate = async (data) => {
    const res = await fetch("/api/combos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Failed to create combo");
    }
    const created = await res.json().catch(() => null);
    // Refetch first so the new combo is in the list, then select it and drop
    // ?create=1 in one navigation so the two URL writes can't race.
    await fetchData();
    setShowCreateModal(false);
    if (created?.id) {
      setSelectedId(created.id);
      navigateCombos(router, { combo: created.id, create: false }, "push");
    } else {
      navigateCombos(router, { create: false });
    }
  };

  // Atomic per-combo strategy patch: server merges `patch` into
  // settings.comboStrategies[name] and drops the entry when the strategy
  // resolves to default "fallback". Serialized so rapid edits never race.
  const handleSetComboStrategy = (comboName, patch) => {
    const run = saveQueueRef.current
      .then(async () => {
        const res = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ comboStrategyPatch: { name: comboName, patch } }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Save failed (${res.status})`);
        }
        const base = strategiesRef.current[comboName] || {};
        const next = { ...base, ...patch };
        if (patch.weights) next.weights = { ...base.weights, ...patch.weights };
        const updated = { ...strategiesRef.current };
        if (!next.fallbackStrategy || next.fallbackStrategy === "fallback") {
          delete updated[comboName];
        } else {
          updated[comboName] = next;
        }
        strategiesRef.current = updated;
        setComboStrategies(updated);
        return { ok: true };
      })
      .catch((error) => ({ ok: false, error: error?.message || "Save failed — network error" }));
    saveQueueRef.current = run;
    return run;
  };

  const selectedEntry = selected ? comboStrategies[selected.name] || {} : {};
  const healthByProvider = healthByConnections(activeProviders);
  const providerLabelById = providerLabelsByConnections(activeProviders);

  const handleSaveRoute = async () => {
    if (!selected) return;
    setSaving(true);
    setSaveError("");
    try {
      // Persist the ordered models first (PUT validates name/models server-side).
      const res = await fetch(`/api/combos/${selected.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: draftModels || [] }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to save route");
      }
      // Then the strategy (weights delta only; judge included for fusion).
      const patch = { fallbackStrategy: draftStrategy };
      if (draftStrategy === "weighted") patch.weights = draftWeights;
      if (draftStrategy === "fusion" && draftJudge) patch.judgeModel = draftJudge;
      if (draftStrategy === "fusion" && !draftJudge && selectedEntry.judgeModel) {
        patch.judgeModel = "";
      }
      const result = await handleSetComboStrategy(selected.name, patch);
      if (!result?.ok) throw new Error(result?.error || "Failed to save strategy");
      const combosRes = await fetch("/api/combos");
      const settingsRes = await fetch("/api/settings");
      if (combosRes.ok && settingsRes.ok) {
        const combosData = await combosRes.json();
        const settingsData = await settingsRes.json();
        const list = (combosData.combos || []).filter((c) => !c.kind || c.kind === "llm");
        const strategies = settingsData.comboStrategies || {};
        strategiesRef.current = strategies;
        setComboStrategies(strategies);
        setCombos(list);
        const fresh = list.find((c) => c.id === selected.id) || null;
        seededIdRef.current = selected.id;
        applyServerState(fresh, strategies);
      } else {
        await fetchData();
      }
    } catch (error) {
      setSaveError(error?.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleRename = async (nextName) => {
    if (!selected || nextName === selected.name) return;
    setSaving(true);
    setSaveError("");
    try {
      const res = await fetch(`/api/combos/${selected.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nextName }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to rename combo");
      }
      await fetchData();
    } catch (error) {
      setSaveError(error?.message || "Failed to rename");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    if (!selected) return;
    // Capture id/name now: the confirm dialog stays open while the user can
    // still switch selection, so the confirm must not read live `selected`.
    const { id: deleteId, name: deleteName } = selected;
    setConfirmState({
      title: "Delete Combo",
      message: `Delete combo "${deleteName}"? This cannot be undone.`,
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/combos/${deleteId}`, { method: "DELETE" });
          if (!res.ok) throw new Error(`delete ${res.status}`);
          setComboStrategies((prev) => {
            if (!Object.hasOwn(prev, deleteName)) return prev;
            const next = { ...prev };
            delete next[deleteName];
            strategiesRef.current = next;
            return next;
          });
          const rest = combos.filter((c) => c.id !== deleteId);
          const nextId = resolveComboSelection(
            null,
            rest,
            selectedId === deleteId ? null : selectedId,
          );
          if (selectedComboId === deleteId) navigate(nextId, "replace");
          setCombos(rest);
          setSelectedId(nextId);
        } catch (error) {
          setSaveError(error?.message || "Failed to delete combo");
        }
      },
    });
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-4" role="status" aria-label="Loading combos">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  if (loadError && combos.length === 0) {
    return (
      <EmptyState
        icon="error"
        title="Couldn't load combos"
        body={loadError}
        action={
          <Button
            icon="refresh"
            onClick={() => {
              setLoading(true);
              fetchData();
            }}
          >
            Retry
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <SectionCard
        icon="layers"
        title="Combos"
        subtitle="One name, many models. Pick how they take turns."
      />

      {combos.length === 0 ? (
        <EmptyState
          icon="layers"
          title="No combos yet"
          body="Create model combos with fallback support."
          action={
            <Button icon="add" onClick={openCreate}>
              New combo
            </Button>
          }
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-6 lg:flex-row lg:items-start">
          {/* List column */}
          <div className="flex w-full min-w-0 shrink-0 flex-col gap-3 lg:w-80">
            <Button icon="add" fullWidth onClick={openCreate}>
              New combo
            </Button>
            <ul aria-label="Combos" className="m-0 flex list-none flex-col gap-3 p-0">
              {combos.map((combo) => {
                const sid = strategyOf(comboStrategies, combo.name);
                return (
                  <li key={combo.id}>
                    <ComboListCard
                      combo={combo}
                      strategy={sid}
                      strategyLabel={strategyLabelOf(sid)}
                      strategyVariant={STRATEGY_PILL[sid] || "brand"}
                      usageToday={usageToday[combo.id] || 0}
                      selected={combo.id === selectedComboId}
                      onSelect={selectCombo}
                    />
                  </li>
                );
              })}
            </ul>
            <section aria-label="Capability adapter" className="flex flex-col gap-3">
              <h2 className="text-xs font-semibold tracking-wider text-muted uppercase">
                Capability adapter
              </h2>
              <CapabilityAdapterCard
                capacityAdapter={capacityAdapter}
                onChange={handleSetCapacityAdapter}
                activeProviders={activeProviders}
                getCaps={getCaps}
              />
              {adapterError && (
                <p role="alert" className="text-xs text-err">
                  {adapterError}
                </p>
              )}
            </section>
          </div>

          {/* Editor */}
          {selected && draftModels !== null && (
            <ComboEditor
              key={selected.id}
              combo={{ ...selected, models: draftModels }}
              strategy={draftStrategy}
              weights={draftWeights}
              judgeModel={draftJudge}
              headroom={headroom}
              healthByProvider={healthByProvider}
              providerLabelById={providerLabelById}
              saving={saving}
              saveError={saveError}
              onRename={handleRename}
              onDelete={handleDelete}
              onSave={handleSaveRoute}
              onStrategyChange={(s) => {
                setDraftStrategy(s);
                setSaveError("");
              }}
              onWeightSave={async (model, value) => {
                setDraftWeights((prev) => ({ ...prev, [model]: value }));
                const result = await handleSetComboStrategy(selected.name, {
                  fallbackStrategy: "weighted",
                  weights: { [model]: value },
                });
                if (!result?.ok) setSaveError(result?.error || "Failed to save weight");
              }}
              onJudgeChange={async (value) => {
                setDraftJudge(value);
                const result = await handleSetComboStrategy(selected.name, {
                  fallbackStrategy: "fusion",
                  judgeModel: value,
                });
                if (!result?.ok) setSaveError(result?.error || "Failed to save judge");
              }}
              onModelsChange={(next) => {
                setDraftModels(next);
                setSaveError("");
              }}
              activeProviders={activeProviders}
              modelAliases={modelAliases}
            />
          )}
        </div>
      )}

      {showCreateModal && (
        <ComboFormModal
          key="create"
          isOpen={showCreateModal}
          onClose={closeCreate}
          onSave={handleCreate}
          activeProviders={activeProviders}
        />
      )}

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </div>
  );
}

/**
 * Real connection state per provider id: Healthy (active), Auth error /
 * Unavailable (error), Paused (all disabled), or No data. Mirrors the
 * providers page effective-status semantics.
 */
export function healthByConnections(connections) {
  const byProvider = {};
  for (const c of connections || []) {
    if (!byProvider[c.provider]) byProvider[c.provider] = [];
    byProvider[c.provider].push(c);
  }
  const out = {};
  for (const [providerId, list] of Object.entries(byProvider)) {
    const effective = (conn) => {
      const cooling = Object.entries(conn).some(
        ([k, v]) => k.startsWith("modelLock_") && v && new Date(v).getTime() > Date.now(),
      );
      return conn.testStatus === "unavailable" && !cooling ? "active" : conn.testStatus;
    };
    const statuses = list.map(effective);
    if (list.length > 0 && list.every((c) => c.isActive === false)) {
      out[providerId] = { label: "Paused", variant: "neutral" };
    } else if (statuses.some((s) => s === "active" || s === "success")) {
      out[providerId] = { label: "Healthy", variant: "ok" };
    } else if (statuses.some((s) => s === "error" || s === "expired" || s === "unavailable")) {
      const tag = errorTag(
        list.find(
          (c) =>
            effective(c) === "error" ||
            effective(c) === "expired" ||
            effective(c) === "unavailable",
        ),
      );
      out[providerId] = { label: tag || "Error", variant: "err" };
    } else {
      out[providerId] = { label: "No data", variant: "neutral" };
    }
  }
  return out;
}

function errorTag(conn) {
  if (!conn) return null;
  if (conn.lastErrorType === "upstream_rate_limited") return "429";
  if (conn.lastErrorType === "upstream_unavailable") return "5XX";
  if (
    conn.lastErrorType === "upstream_auth_error" ||
    conn.lastErrorType === "auth_missing" ||
    conn.lastErrorType === "token_refresh_failed" ||
    conn.lastErrorType === "token_expired"
  ) {
    return "Auth error";
  }
  const code = Number(conn.errorCode);
  if (Number.isFinite(code) && code >= 400) return String(code);
  return "Error";
}

function providerLabelsByConnections(connections) {
  const map = {};
  for (const c of connections || []) {
    if (c.provider && !map[c.provider]) map[c.provider] = c.name || c.provider;
  }
  return map;
}
