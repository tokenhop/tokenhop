import { create } from "zustand";
import { debounce } from "@/shared/utils/debounce";

/**
 * Saved CLI tool card settings (`/api/cli-tool-settings`), shared by every
 * mounted card. Writes per tool are serialized so a reset or a newer save
 * never races an older request.
 */
export const useToolSettingsStore = create(() => ({
  saved: {},
  loaded: false,
  loadFailed: false,
  status: {},
}));

const SAVE_DEBOUNCE_MS = 500;
const savers = new Map(); // toolId -> { dirty, queue, debounced }

const setStatus = (toolId, status) =>
  useToolSettingsStore.setState((s) => ({ status: { ...s.status, [toolId]: status } }));

const api = (toolId, init) => fetch(`/api/cli-tool-settings/${toolId}`, init);

function saverFor(toolId) {
  let saver = savers.get(toolId);
  if (saver) return saver;
  saver = { dirty: false, queue: Promise.resolve() };
  const send = async () => {
    if (!saver.dirty) return;
    saver.dirty = false;
    setStatus(toolId, "saving");
    try {
      const res = await api(toolId, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(useToolSettingsStore.getState().saved[toolId] || {}),
        keepalive: true,
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setStatus(toolId, "saved");
    } catch {
      saver.dirty = true; // retried by the next edit or flush
      setStatus(toolId, "error");
    }
  };
  saver.run = (task) => {
    saver.queue = saver.queue.then(task, task);
    return saver.queue;
  };
  saver.debounced = debounce(() => saver.run(send), SAVE_DEBOUNCE_MS);
  saver.send = send;
  savers.set(toolId, saver);
  return saver;
}

let loadPromise = null;

/**
 * One GET of every tool's saved settings. On failure autosave stays off (a
 * whole-row PUT would wipe what's saved) and the next call retries.
 */
export function loadToolSettings() {
  loadPromise ??= (async () => {
    try {
      const res = await fetch("/api/cli-tool-settings");
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      useToolSettingsStore.setState({
        saved: data.settings || {},
        loaded: true,
        loadFailed: false,
      });
    } catch {
      loadPromise = null;
      useToolSettingsStore.setState({ loaded: true, loadFailed: true });
    }
  })();
  return loadPromise;
}

/** Merge `patch` into a tool's saved row (`undefined` deletes a key) and autosave. */
export function setToolSettings(toolId, patch) {
  useToolSettingsStore.setState((s) => {
    const next = { ...s.saved[toolId], ...patch };
    for (const key of Object.keys(patch)) if (patch[key] === undefined) delete next[key];
    return { saved: { ...s.saved, [toolId]: next } };
  });
  if (useToolSettingsStore.getState().loadFailed) {
    setStatus(toolId, "error");
    return;
  }
  const saver = saverFor(toolId);
  saver.dirty = true;
  saver.debounced();
}

/** Send a pending save now (unmount, `beforeunload`). */
export function flushToolSettings(toolId) {
  const saver = savers.get(toolId);
  if (!saver?.dirty) return Promise.resolve();
  saver.debounced.cancel();
  return saver.run(saver.send);
}

/** Delete a tool's saved row once any in-flight save has settled. */
export async function resetToolSettings(toolId) {
  const saver = saverFor(toolId);
  saver.debounced.cancel();
  saver.dirty = false;
  let ok = false;
  await saver.run(async () => {
    try {
      ok = (await api(toolId, { method: "DELETE" })).ok;
    } catch {
      ok = false;
    }
  });
  useToolSettingsStore.setState((s) => {
    if (!ok) return { status: { ...s.status, [toolId]: "error" } };
    const { [toolId]: _removed, ...rest } = s.saved;
    return { saved: rest, status: { ...s.status, [toolId]: "" } };
  });
  return ok;
}

/** Test hook: forget the cached load and pending savers. */
export function __resetToolSettingsStore() {
  loadPromise = null;
  for (const saver of savers.values()) saver.debounced.cancel();
  savers.clear();
  useToolSettingsStore.setState({ saved: {}, loaded: false, loadFailed: false, status: {} });
}
