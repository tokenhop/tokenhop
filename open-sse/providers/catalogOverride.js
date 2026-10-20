// Read side of the model catalog synced from models.dev.
//
// The file is the source of truth; the only thing held in memory is a parsed
// copy dropped as soon as the file's mtime changes. getCapabilitiesForModel is
// synchronous and runs several times per request, so the file is stat'ed at most
// once per STAT_INTERVAL_MS (the parse, ~0.1ms on a ~18KB file, only reruns after
// a sync). The in-process writer calls invalidateCatalog(), which forces an
// immediate re-stat; only a write from another process waits out the interval.

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

export const CATALOG_FILE = path.join(DATA_DIR, "model-catalog.json");
// Trimmed upstream catalog, read by the add-models skill (not by the router).
export const CATALOG_RAW_FILE = path.join(DATA_DIR, "model-catalog-raw.json");

// Schema of the file this module reads. The writer stamps it; a file carrying an
// older value predates provider-scoped modality keys, and its flat keys are not
// looked up here, so the sync rebuilds it instead of asking upstream for a 304.
export const CATALOG_VERSION = 2;

export const STAT_INTERVAL_MS = 1000;

const EMPTY = { models: {}, providers: {} };
// ALL mutable state lives on one shared slot so duplicate bundle copies of this
// module agree (like apiKeyState's tracker): an invalidateCatalog() through one
// copy resets the stat clock and mtime for every copy, not just the generation.
// `cache: null` means "no catalog file / unparsable".
const SLOT_KEY = Symbol.for("tokenhop.catalogGeneration");
globalThis[SLOT_KEY] ??= { n: 0, cache: null, cachedMtime: -1, checkedAt: -Infinity };
const slot = globalThis[SLOT_KEY]; // n = generation: bumps whenever the served snapshot may have changed

/** Changes whenever the catalog snapshot is invalidated or re-read from disk. */
export const catalogGeneration = () => slot.n;

// "zai-org/GLM-4.6V:free" -> "glm-4.6v"
function baseId(model) {
  if (!model) return "";
  const withoutVendor = model.includes("/") ? model.split("/").pop() : model;
  return withoutVendor.toLowerCase().split(":")[0];
}

function load() {
  const now = Date.now();
  // Backwards clock jumps re-stat too (now < checkedAt).
  if (now >= slot.checkedAt && now - slot.checkedAt < STAT_INTERVAL_MS) return slot.cache ?? EMPTY;
  slot.checkedAt = now;
  let mtime;
  try {
    mtime = fs.statSync(CATALOG_FILE).mtimeMs;
  } catch {
    if (slot.cache) slot.n++;
    slot.cache = null;
    slot.cachedMtime = -1;
    return EMPTY;
  }
  if (mtime === slot.cachedMtime) return slot.cache ?? EMPTY;

  slot.n++;
  slot.cachedMtime = mtime;
  try {
    const parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
    slot.cache = { models: parsed?.models || {}, providers: parsed?.providers || {} };
  } catch {
    slot.cache = null;
  }
  return slot.cache ?? EMPTY;
}

// Modalities are recorded per gateway upstream, and gateways disagree about the
// same weights — some do not proxy images at all — so the key is provider +
// model, in the local provider id space, exactly like the limits below. Keying
// by model id alone made short ids collide across vendors: "auto", "free" and
// "efficient" are router modes in one catalog and model names in another, and a
// request to the router mode inherited a stranger's vision.
function modalitiesIn(snapshot, provider, model) {
  if (!provider) return null;
  return snapshot.models[`${provider}:${baseId(model)}`] || null;
}

// Context and output limits are a property of the gateway too: each one
// truncates differently, so these stay keyed by provider + model.
function limitsIn(snapshot, provider, model) {
  const byProvider = provider && snapshot.providers[provider];
  if (!byProvider) return null;
  return byProvider[model] || byProvider[baseId(model)] || null;
}

export function getCatalogModalities(provider, model) {
  return modalitiesIn(load(), provider, model);
}

export function getCatalogLimits(provider, model) {
  return limitsIn(load(), provider, model);
}

// Both lookups against one snapshot: a single stat (and at most one parse) per
// call, and modalities and limits can never come from two different files.
export function getCatalogEntry(provider, model) {
  const snapshot = load();
  return {
    modalities: modalitiesIn(snapshot, provider, model),
    limits: limitsIn(snapshot, provider, model),
  };
}

// Force a re-read on the next lookup (called right after a sync writes the file).
export function invalidateCatalog() {
  slot.cachedMtime = -1;
  slot.checkedAt = -Infinity;
  slot.n++;
}

// Hand the reader to capabilities.js. That module is bundled into the browser
// too, so it cannot import this file directly — the server pushes it in.
export async function installCatalogSource() {
  const { setCatalogSource } = await import("./capabilities.js");
  setCatalogSource({
    getModalities: getCatalogModalities,
    getLimits: getCatalogLimits,
    getEntry: getCatalogEntry,
  });
}
