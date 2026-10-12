"use client";

import { useEffect, useState } from "react";

// YAN-373: pending-approval count for the Users nav badge. One shared poller
// for desktop sidebar + mobile drawer, mirroring useShellStatus. The count is
// `totalItems` from the server-filtered users page (`role=pending`,
// `status=active`, `pageSize=1`) — no user rows are read.

const REFRESH_MS = 60_000;

const store = { count: null, timer: null, inFlight: null, queued: false, listeners: new Set() };

/**
 * Map a `/api/users?role=pending&status=active&pageSize=1` response to a
 * badge count. Anything unexpected keeps the previous value (never a fake 0).
 * @param {object|null} body
 * @returns {number|null}
 */
export function pendingCountFrom(body) {
  const total = body?.pagination?.totalItems;
  return Number.isInteger(total) && total >= 0 ? total : null;
}

async function fetchCount() {
  try {
    const res = await fetch("/api/users?role=pending&status=active&pageSize=1", {
      cache: "no-store",
    });
    // 403 (member) and 404 (switch off) both mean "no badge": silent.
    if (!res.ok) return;
    const next = pendingCountFrom(await res.json().catch(() => null));
    if (next !== null) store.count = next;
  } catch {
    /* offline: keep the last count */
  }
  for (const listener of store.listeners) listener(store.count);
}

/**
 * Poll now (used after an admin approves a user). Queues at most one retry
 * behind an in-flight poll, like refreshShellStatus.
 * @returns {Promise<void>}
 */
export function refreshPendingUsers() {
  if (typeof window === "undefined") return Promise.resolve();
  if (store.inFlight) {
    // A mutation landed mid-poll: that response may predate it. Run once more.
    store.queued = true;
    return store.inFlight;
  }
  store.inFlight = fetchCount().finally(() => {
    store.inFlight = null;
    if (store.queued) {
      store.queued = false;
      refreshPendingUsers();
    }
  });
  return store.inFlight;
}

function start() {
  refreshPendingUsers();
  store.timer = window.setInterval(() => {
    if (!document.hidden) refreshPendingUsers();
  }, REFRESH_MS);
}

function stop() {
  window.clearInterval(store.timer);
  store.timer = null;
}

/**
 * Pending-approval count, or null while unknown. Only polls while
 * `multiUser` is true (the nav item is hidden otherwise).
 * @param {boolean} multiUser Users & teams switch from the shell summary.
 * @returns {number|null}
 */
export default function usePendingUsers(multiUser) {
  const [count, setCount] = useState(store.count);

  useEffect(() => {
    if (!multiUser) return undefined;
    const listener = (next) => setCount(next);
    store.listeners.add(listener);
    if (store.listeners.size === 1) start();
    else listener(store.count);
    return () => {
      store.listeners.delete(listener);
      if (store.listeners.size === 0) stop();
    };
  }, [multiUser]);

  return count;
}
