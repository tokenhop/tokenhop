"use client";

import { useState, useEffect, useRef } from "react";
import { useParams, notFound, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Card,
  Button,
  Input,
  Toggle,
  ModelSelectModal,
  ConfirmDialog,
  Callout,
} from "@/shared/components";
import ProviderTile from "@/shared/components/ProviderTile";
import { AI_PROVIDERS, MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { previewAuthHeader } from "@/shared/constants/previewAuth";
import { createObjectUrlRegistry } from "@/shared/constants/playgroundUrls";

// Parse "providerId/model" or just "providerId" → { providerId, model }
function parseModelEntry(entry) {
  if (typeof entry !== "string") return { providerId: "", model: "" };
  const idx = entry.indexOf("/");
  if (idx < 0) return { providerId: entry, model: "" };
  return { providerId: entry.slice(0, idx), model: entry.slice(idx + 1) };
}

const VALID_NAME_REGEX = /^[a-zA-Z0-9_.-]+$/;

const KIND_LABELS = {
  webSearch: "Web Search",
  webFetch: "Web Fetch",
  image: "Text to Image",
  tts: "Text To Speech",
};

const EXAMPLE_PATHS = {
  webSearch: "/v1/search",
  webFetch: "/v1/web/fetch",
  image: "/v1/images/generations",
  tts: "/v1/audio/speech",
  embedding: "/v1/embeddings",
  video: "/v1/videos/generations",
  stt: "/v1/audio/transcriptions",
};

const EXAMPLE_BODIES = {
  webSearch: (n) => ({
    model: n,
    query: "What is the latest news about AI?",
    search_type: "web",
    max_results: 5,
  }),
  webFetch: (n) => ({ model: n, url: "https://example.com", format: "markdown" }),
  image: (n) => ({ model: n, prompt: "A cute cat playing piano", n: 1, size: "1024x1024" }),
  tts: (n) => ({ model: n, input: "Hello, this is a test.", voice: "alloy" }),
  embedding: (n) => ({ model: n, input: "The quick brown fox jumps over the lazy dog" }),
  video: (n) => ({ model: n, prompt: "A serene lake at sunset" }),
  stt: (n) => ({ model: n, prompt: "Transcribe this audio" }),
};

// Map combo.kind → listing route to go back to
function getListingHref(kind) {
  if (kind === "webSearch" || kind === "webFetch") return "/dashboard/media-providers/web";
  return `/dashboard/media-providers/${kind}`;
}

export default function ComboDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const [combo, setCombo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [providers, setProviders] = useState([]);
  const [roundRobin, setRoundRobin] = useState(false);
  const [savingStrategy, setSavingStrategy] = useState(false);
  const savingStrategyRef = useRef(false);
  // Serializes rename + strategy toggle so the toggle PATCH never targets a stale name.
  const opQueueRef = useRef(Promise.resolve());
  const comboNameRef = useRef("");
  const [showPicker, setShowPicker] = useState(false);
  const [logs, setLogs] = useState([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [connections, setConnections] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [origin, setOrigin] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Ref-tracked blob URLs: the unmount cleanup revokes the live URLs even
  // though React state is stale inside cleanup closures.
  const testUrlsRef = useRef({ image: "", audio: "" });
  const [testUrls] = useState(() => createObjectUrlRegistry(testUrlsRef));

  // Revoke live test blob URLs on unmount via the ref (state is stale here).
  // biome-ignore lint/correctness/useExhaustiveDependencies: cleanup on unmount only
  useEffect(() => testUrls.revokeAll, []);

  const fetchAll = async () => {
    try {
      const [comboRes, settingsRes, logsRes, keysRes, connsRes, aliasesRes] = await Promise.all([
        fetch(`/api/combos/${id}`, { cache: "no-store" }),
        fetch("/api/settings", { cache: "no-store" }),
        fetch("/api/usage/logs", { cache: "no-store" }),
        fetch("/api/keys", { cache: "no-store" }),
        fetch("/api/providers", { cache: "no-store" }),
        fetch("/api/models/alias", { cache: "no-store" }),
      ]);
      if (aliasesRes.ok) setModelAliases((await aliasesRes.json()).aliases || {});
      if (keysRes.ok) {
        const k = await keysRes.json();
        setApiKey((k.keys || []).find((x) => x.isActive !== false)?.key || "");
      }
      if (connsRes.ok) setConnections((await connsRes.json()).connections || []);
      if (!comboRes.ok) {
        setCombo(null);
        setLoading(false);
        return;
      }
      const c = await comboRes.json();
      comboNameRef.current = c.name;
      setCombo(c);
      setName(c.name);
      setProviders(c.models || []);
      const s = settingsRes.ok ? await settingsRes.json() : {};
      setRoundRobin(s.comboStrategies?.[c.name]?.fallbackStrategy === "round-robin");
      const allLogs = logsRes.ok ? await logsRes.json() : [];
      setLogs(allLogs.filter((l) => typeof l === "string" && l.includes(c.name)).slice(0, 50));
    } catch {
      /* noop */
    }
    setLoading(false);
  };

  useEffect(() => {
    setOrigin(window.location.origin);
    fetchAll();
  }, [id]);

  const validateName = (v) => {
    if (!v.trim()) {
      setNameError("Name is required");
      return false;
    }
    if (!VALID_NAME_REGEX.test(v)) {
      setNameError("Only letters, numbers, -, _ and .");
      return false;
    }
    setNameError("");
    return true;
  };

  const saveCombo = async (patch) => {
    const res = await fetch(`/api/combos/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setSaveError(err.error || "Failed to save");
      return false;
    }
    setSaveError("");
    return true;
  };

  // Chain fn after any in-flight rename/toggle; a failure never blocks later ops.
  const enqueue = (fn) => {
    const run = opQueueRef.current.then(fn);
    opQueueRef.current = run.catch(() => {});
    return run;
  };

  const handleSaveName = () => {
    if (!validateName(name)) return;
    const nextName = name;
    return enqueue(async () => {
      if (nextName === comboNameRef.current) return;
      const ok = await saveCombo({ name: nextName });
      if (ok) await fetchAll();
    }).catch(() => setSaveError("Failed to save — network error"));
  };

  const handleAddModel = async (model) => {
    const value = model?.value || model;
    if (!value || providers.includes(value)) return;
    const next = [...providers, value];
    setProviders(next);
    await saveCombo({ models: next });
  };

  const handleDeselectModel = async (model) => {
    const value = model?.value || model;
    if (!value || !providers.includes(value)) return;
    const next = providers.filter((p) => p !== value);
    setProviders(next);
    await saveCombo({ models: next });
  };

  const handleRemoveProvider = async (idx) => {
    const next = providers.filter((_, i) => i !== idx);
    setProviders(next);
    await saveCombo({ models: next });
  };

  const handleMove = async (idx, dir) => {
    const next = [...providers];
    const swap = idx + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    setProviders(next);
    await saveCombo({ models: next });
  };

  // Atomic per-combo PATCH: the server merges only this combo's entry, so a failed
  // request can never wipe other combos. Only runs on an explicit user toggle, so a
  // stored "weighted"/"fusion" strategy is never rewritten on load. Switching on keeps
  // existing weights (server merges); switching off sets "fallback", which drops the
  // whole entry (weights included) per the existing prune semantics.
  // Disable while saving; ref closes the gap before React applies disabled state.
  // Queued behind any pending rename and reads the name at send time, so it never
  // PATCHes a stale combo name. 409 = name changed server-side: refetch, don't revert.
  const handleToggleRoundRobin = async (enabled) => {
    if (savingStrategyRef.current || !comboNameRef.current) return;
    savingStrategyRef.current = true;
    const previous = roundRobin;
    setRoundRobin(enabled);
    setSavingStrategy(true);
    let error = "";
    let conflict = false;
    try {
      await enqueue(async () => {
        const res = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comboStrategyPatch: {
              name: comboNameRef.current,
              patch: { fallbackStrategy: enabled ? "round-robin" : "fallback" },
            },
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          error = err.error || `Failed to save (${res.status})`;
          conflict = res.status === 409;
          if (conflict) {
            error = "Combo was renamed elsewhere — refreshed, please retry";
            await fetchAll();
          }
        }
      });
    } catch {
      error = "Failed to save — network error";
    } finally {
      savingStrategyRef.current = false;
      setSavingStrategy(false);
    }
    if (!error) {
      // A queued rename's fetchAll may have reset the toggle to pre-save server state.
      setRoundRobin(enabled);
      setSaveError("");
      return;
    }
    if (!conflict) setRoundRobin(previous);
    setSaveError(error);
  };

  const handleDelete = async () => {
    const res = await fetch(`/api/combos/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error || `Delete failed (HTTP ${res.status})`);
    }
    router.push(getListingHref(combo.kind));
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestError("");
    testUrls.clear();
    const start = Date.now();
    try {
      const path = EXAMPLE_PATHS[combo.kind];
      const body = EXAMPLE_BODIES[combo.kind](combo.name);
      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const res = await fetch(`/api${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const latencyMs = Date.now() - start;
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setTestError(d?.error?.message || d?.error || `HTTP ${res.status}`);
        setTestResult({ json: JSON.stringify(d, null, 2), latencyMs });
        return;
      }
      const ctype = res.headers.get("content-type") || "";
      // Binary image (registry revokes the previous URL on replace and on unmount)
      if (ctype.startsWith("image/")) {
        const blob = await res.blob();
        const nextUrl = URL.createObjectURL(blob);
        testUrls.setImage(nextUrl);
        setTestResult({ imageUrl: nextUrl, latencyMs });
        return;
      }
      // Binary audio (registry revokes the previous URL on replace and on unmount)
      if (ctype.startsWith("audio/") || ctype === "application/octet-stream") {
        const blob = await res.blob();
        const nextUrl = URL.createObjectURL(blob);
        testUrls.setAudio(nextUrl);
        setTestResult({ audioUrl: nextUrl, latencyMs });
        return;
      }
      // JSON — could be image (data[0].b64_json/url) or generic
      const data = await res.json();
      const first = data?.data?.[0];
      const imageUrl = first?.b64_json
        ? `data:image/png;base64,${first.b64_json}`
        : first?.url || "";
      setTestResult({ json: JSON.stringify(maskB64(data), null, 2), imageUrl, latencyMs });
    } catch (e) {
      setTestError(e.message || "Network error");
    }
    setTesting(false);
  };

  // Mask large b64_json strings to keep JSON view readable
  function maskB64(obj) {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(maskB64);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] =
        k === "b64_json" && typeof v === "string" && v.length > 100
          ? `<${v.length} chars base64>`
          : maskB64(v);
    }
    return out;
  }

  if (loading) return <div className="text-text-muted text-sm">Loading...</div>;
  if (!combo) return notFound();

  const kindLabel =
    KIND_LABELS[combo.kind] ||
    MEDIA_PROVIDER_KINDS.find((k) => k.id === combo.kind)?.label ||
    "Combo";
  const examplePath = EXAMPLE_PATHS[combo.kind];
  const exampleBody =
    combo.kind && EXAMPLE_BODIES[combo.kind] ? EXAMPLE_BODIES[combo.kind](combo.name) : null;
  // Preview-safe: rendered/copied cURL always shows Bearer YOUR_KEY.
  // The live key is only sent in the fetch Authorization header below.
  const curlExample =
    examplePath && origin
      ? `curl -X POST ${origin}${examplePath} \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: ${previewAuthHeader(apiKey)}" \\\n  -d '${JSON.stringify(exampleBody)}'`
      : "";
  const backHref = getListingHref(combo.kind);

  return (
    <div className="flex flex-col gap-6">
      {saveError && <Callout variant="err">{saveError}</Callout>}
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <Link href={backHref} className="text-text-muted hover:text-primary">
            <span className="material-symbols-outlined">arrow_back</span>
          </Link>
          <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <span className="material-symbols-outlined text-primary">layers</span>
          </div>
          <div className="min-w-0">
            <p className="text-xs text-text-muted">{kindLabel} Combo</p>
            <code className="text-lg font-semibold font-mono">{combo.name}</code>
          </div>
        </div>
        <Button variant="danger" icon="delete" onClick={() => setConfirmDelete(true)}>
          Delete
        </Button>
      </div>

      {/* Settings Card */}
      <Card>
        <h2 className="text-lg font-semibold mb-3">Settings</h2>
        <div className="flex flex-col gap-4">
          <div>
            <Input
              label="Combo Name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                validateName(e.target.value);
              }}
              onBlur={handleSaveName}
              error={nameError}
            />
            <p className="text-[10px] text-text-muted mt-0.5">Only letters, numbers, -, _ and .</p>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Round Robin</p>
              <p className="text-xs text-text-muted">
                Rotate providers across requests instead of strict fallback order.
              </p>
            </div>
            <Toggle
              checked={roundRobin}
              onChange={handleToggleRoundRobin}
              disabled={savingStrategy}
            />
          </div>
        </div>
      </Card>

      {/* Providers Card */}
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold">Providers</h2>
            <p className="text-xs text-text-muted">
              Tried in order (top-down) or rotated when round-robin is on.
            </p>
          </div>
          <Button size="sm" icon="add" onClick={() => setShowPicker(true)}>
            Add Provider
          </Button>
        </div>
        {providers.length === 0 ? (
          <div className="text-center py-6 border border-dashed border-border rounded-lg text-text-muted text-sm">
            No providers yet.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {providers.map((entry, idx) => {
              const { providerId, model } = parseModelEntry(entry);
              const p = AI_PROVIDERS[providerId];
              return (
                <div
                  key={`${entry}-${idx}`}
                  className="flex items-center gap-3 p-2 rounded-lg bg-black/[0.02] dark:bg-white/[0.02]"
                >
                  <span className="text-xs text-text-muted w-5 text-center">{idx + 1}</span>
                  <ProviderTile providerId={providerId} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{p?.name || providerId}</div>
                    {model && (
                      <code className="text-[10px] text-text-muted font-mono truncate block">
                        {model}
                      </code>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5">
                    <button
                      onClick={() => handleMove(idx, -1)}
                      disabled={idx === 0}
                      className={`p-1 rounded ${idx === 0 ? "text-text-muted/20" : "text-text-muted hover:text-primary hover:bg-black/5"}`}
                      title="Move up"
                    >
                      <span className="material-symbols-outlined text-[16px]">arrow_upward</span>
                    </button>
                    <button
                      onClick={() => handleMove(idx, 1)}
                      disabled={idx === providers.length - 1}
                      className={`p-1 rounded ${idx === providers.length - 1 ? "text-text-muted/20" : "text-text-muted hover:text-primary hover:bg-black/5"}`}
                      title="Move down"
                    >
                      <span className="material-symbols-outlined text-[16px]">arrow_downward</span>
                    </button>
                    <button
                      onClick={() => handleRemoveProvider(idx)}
                      className="p-1 rounded text-text-muted hover:text-red-500 hover:bg-red-500/10"
                      title="Remove"
                    >
                      <span className="material-symbols-outlined text-[16px]">close</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Test Example Card */}
      {combo.kind && examplePath && (
        <Card>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-3">
            <h2 className="text-lg font-semibold">Test Example</h2>
            <Button
              size="sm"
              icon="play_arrow"
              onClick={handleTest}
              disabled={testing || providers.length === 0}
            >
              {testing ? "Running..." : "Run"}
            </Button>
          </div>
          <pre className="text-xs font-mono bg-black/[0.03] dark:bg-white/[0.03] p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-all">
            {curlExample}
          </pre>
          {testError && <p className="mt-3 text-xs text-red-500 break-words">{testError}</p>}
          {testResult && (
            <div className="mt-3 flex flex-col gap-3">
              {testResult.latencyMs != null && (
                <span className="text-[11px] text-text-muted">⚡ {testResult.latencyMs}ms</span>
              )}
              {testResult.imageUrl && (
                <div>
                  <div className="flex items-center justify-end mb-1.5">
                    <a
                      href={testResult.imageUrl}
                      download="image.png"
                      className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-primary transition-colors"
                    >
                      <span className="material-symbols-outlined text-[14px]">download</span>
                      Download
                    </a>
                  </div>
                  <img
                    src={testResult.imageUrl}
                    alt="Generated"
                    className="max-w-full rounded-lg border border-border"
                    loading="lazy"
                    decoding="async"
                  />
                </div>
              )}
              {testResult.audioUrl && (
                <div>
                  <div className="flex items-center justify-end mb-1.5">
                    <a
                      href={testResult.audioUrl}
                      download="speech.mp3"
                      className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-primary transition-colors"
                    >
                      <span className="material-symbols-outlined text-[14px]">download</span>
                      Download
                    </a>
                  </div>
                  <audio controls src={testResult.audioUrl} className="w-full" />
                </div>
              )}
              {testResult.json && (
                <pre className="text-xs font-mono bg-black/[0.03] dark:bg-white/[0.03] p-3 rounded-lg overflow-auto max-h-[300px] whitespace-pre-wrap break-all">
                  {testResult.json}
                </pre>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Usage Logs Card */}
      <Card>
        <h2 className="text-lg font-semibold mb-3">Usage Logs</h2>
        {logs.length === 0 ? (
          <p className="text-xs text-text-muted italic">No usage yet.</p>
        ) : (
          <pre className="text-[11px] font-mono bg-black/[0.03] dark:bg-white/[0.03] p-3 rounded-lg overflow-auto max-h-[400px] whitespace-pre-wrap">
            {logs.join("\n")}
          </pre>
        )}
      </Card>

      {showPicker && (
        <ModelSelectModal
          isOpen={showPicker}
          onClose={() => setShowPicker(false)}
          onSelect={handleAddModel}
          onDeselect={handleDeselectModel}
          activeProviders={connections}
          modelAliases={modelAliases}
          title={`Add ${kindLabel} Model`}
          kindFilter={combo.kind}
          addedModelValues={providers}
          closeOnSelect={false}
        />
      )}

      <ConfirmDialog
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await handleDelete();
          setConfirmDelete(false);
        }}
        title="Delete combo"
        message={`Delete combo "${combo.name}"?`}
        confirmText="Delete"
      />
    </div>
  );
}
