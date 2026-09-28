// Quota account derivation for the Home quota watch widget.
// Reads server-side in-memory quota snapshots (open-sse/services/quotaSnapshot.js)
// — no upstream probes, so nothing here is rate-limited or slow.

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Pick the primary window for a snapshot: the highest used fraction,
 * mirroring how the quota page surfaces "the worst window".
 * @param {Array<object>} windows snapshot windows ({ kind, usedFraction, resetsAt })
 * @returns {object|null}
 */
function primaryWindow(windows) {
  if (!Array.isArray(windows)) return null;
  let best = null;
  for (const window of windows) {
    const used = finite(window?.usedFraction);
    if (used === null) continue;
    if (!best || used > best.used) best = { used, resetsAt: window?.resetsAt ?? null };
  }
  return best;
}

/**
 * Derive quota accounts from provider connections and a snapshot lookup.
 * Pure (no IO): `getSnapshotView` is injected so tests can stub it.
 * `kind` mirrors the server quota snapshot view: "unlimited" for accounts
 * with no measurable windows (plan tier known, nothing to meter), otherwise
 * null so the widget meters the remaining percentage.
 *
 * @param {Array<object>} connections provider connection rows ({ id, provider, name, email })
 * @param {(connectionId: string) => object|null} getSnapshotView snapshot view lookup
 * @returns {Array<{ id: string, provider: string, name: string, remaining: number|null, resetsAt: string|null, kind: string|null }>}
 */
export function deriveQuotaAccounts(connections, getSnapshotView) {
  if (!Array.isArray(connections)) return [];
  return connections.map((connection) => {
    const id = connection?.id ?? "";
    const provider = connection?.provider ?? "";
    const name =
      [connection?.name, connection?.email].find(
        (part) => typeof part === "string" && part.trim().length > 0,
      ) || id;

    let remaining = null;
    let resetsAt = null;
    const kind = null;
    try {
      const best = primaryWindow(getSnapshotView?.(id)?.windows);
      if (best) {
        remaining = Math.max(0, Math.min(100, Math.round((1 - best.used) * 100)));
        resetsAt =
          typeof best.resetsAt === "string" && best.resetsAt
            ? best.resetsAt
            : typeof best.resetsAt === "number" && Number.isFinite(best.resetsAt)
              ? new Date(best.resetsAt).toISOString()
              : null;
      }
    } catch {
      /* a broken snapshot row degrades this account, not the whole widget */
    }

    return { id, provider, name, remaining, resetsAt, kind };
  });
}
