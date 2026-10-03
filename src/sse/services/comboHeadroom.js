// Weighted combo headroom (YAN-261). App-side: open-sse must not import localDb,
// so handlers build this fn here and inject it into handleComboChat.
import { getProviderConnectionsUnscoped } from "@/lib/localDb";
import { getProviderHeadroom } from "open-sse/services/quotaSnapshot.js";
import { parseModel } from "./model.js";

/** Fail-open quota detail: unknown quota never reads as exhausted. */
const NO_QUOTA_DATA = { headroom: 1, source: "static" };

function normalizeDetail(detail) {
  const n = Number(detail?.headroom);
  const source = detail?.source;
  return {
    headroom: Number.isFinite(n) && n >= 0 ? n : 1,
    source: source === "header" || source === "probe" ? source : "static",
  };
}

async function connectionsByProvider(listConnections) {
  const idsByProvider = new Map();
  for (const { id, provider } of await listConnections({ isActive: true })) {
    if (!idsByProvider.has(provider)) idsByProvider.set(provider, []);
    idsByProvider.get(provider).push(id);
  }
  return idsByProvider;
}

function detailFor(modelStr, idsByProvider) {
  if (!modelStr.includes("/")) {
    // Bare provider id or alias (fetch/search combo members).
    // Parse as "<member>/" so bare ids get the same (local) alias resolution.
    const { provider } = parseModel(`${modelStr}/`);
    const ids = idsByProvider.get(provider);
    return ids ? normalizeDetail(getProviderHeadroom(provider, ids, null)) : NO_QUOTA_DATA;
  }
  const { provider, model, isAlias } = parseModel(modelStr);
  const ids = !isAlias && provider ? idsByProvider.get(provider) : null;
  return ids ? normalizeDetail(getProviderHeadroom(provider, ids, model)) : NO_QUOTA_DATA;
}

/**
 * Build a synchronous, memoized `(modelStr) => { headroom, source }` for combo
 * members, where `source` says where the quota number came from
 * ("static" = no data yet, "header" = provider-reported, "probe" = quota
 * probe). One active-connections query per call; never throws. Unknown
 * models, aliases, nested combo names and custom-node prefixes get
 * headroom 1 / "static". DB errors give 1 / "static" for all.
 * @param {{ getProviderConnectionsUnscoped?: Function }} [deps]
 * @returns {Promise<(modelStr: string) => { headroom: number, source: "static"|"header"|"probe" }>}
 */
export async function loadComboHeadroomDetailFn({
  getProviderConnectionsUnscoped: listConnections = getProviderConnectionsUnscoped,
} = {}) {
  let idsByProvider;
  try {
    idsByProvider = await connectionsByProvider(listConnections);
  } catch {
    return () => NO_QUOTA_DATA;
  }

  const cache = new Map();
  return (modelStr) => {
    if (typeof modelStr !== "string") return NO_QUOTA_DATA;
    if (!cache.has(modelStr)) {
      let detail = NO_QUOTA_DATA;
      try {
        detail = normalizeDetail(detailFor(modelStr, idsByProvider));
      } catch {}
      cache.set(modelStr, detail);
    }
    return cache.get(modelStr);
  };
}

/**
 * Build a synchronous, memoized `(modelStr) => headroom` for combo members.
 * Thin wrapper over `loadComboHeadroomDetailFn`, kept for the chat handlers.
 * @param {{ getProviderConnectionsUnscoped?: Function }} [deps]
 * @returns {Promise<(modelStr: string) => number>}
 */
export async function loadComboHeadroomFn(deps = {}) {
  const detailFn = await loadComboHeadroomDetailFn(deps);
  return (modelStr) => detailFn(modelStr).headroom;
}
