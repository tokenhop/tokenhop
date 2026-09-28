"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { reorderConnections, selectionReducer, sortByPriority } from "../detailUtils";

const ONE_BY_ONE_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Connections state for one provider detail page: fetch, toggle, proxy,
 * bulk selection, reorder persistence, bulk/individual delete, one-by-one test.
 *
 * @param {object} args
 * @param {string} args.providerId
 * @param {(message: string) => void} [args.notifyError]
 */
export function useConnections({ providerId, notifyError }) {
  const [connections, setConnections] = useState([]);
  const [proxyPools, setProxyPools] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [confirmState, setConfirmState] = useState(null);
  const [bulkProxyOpen, setBulkProxyOpen] = useState(false);
  const [bulkProxyUpdating, setBulkProxyUpdating] = useState(false);
  const [oneByOne, setOneByOne] = useState({
    running: false,
    stopping: false,
    currentId: null,
    results: {},
    summary: null,
  });
  const stopRef = useRef(false);
  const notifyRef = useRef(notifyError);
  notifyRef.current = notifyError;

  const fail = useCallback((message, error) => {
    if (error) console.log(message, error);
    notifyRef.current?.(message);
  }, []);

  const fetchConnections = useCallback(async () => {
    const [connectionsRes, proxyPoolsRes] = await Promise.all([
      fetch("/api/providers", { cache: "no-store" }),
      fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }),
    ]);
    const connectionsData = await connectionsRes.json().catch(() => ({}));
    const proxyPoolsData = await proxyPoolsRes.json().catch(() => ({}));
    if (connectionsRes.ok) {
      // Single ordering everywhere: rows, bubbles, DnD items, up/down and one-by-one.
      setConnections(
        sortByPriority(
          (connectionsData.connections || []).filter((entry) => entry.provider === providerId),
        ),
      );
    }
    if (proxyPoolsRes.ok) setProxyPools(proxyPoolsData.proxyPools || []);
  }, [providerId]);

  useEffect(() => {
    setSelectedIds((prev) =>
      selectionReducer(prev, {
        type: "prune",
        existingIds: connections.map((entry) => entry.id),
      }),
    );
  }, [connections]);

  const toggleSelect = useCallback((id) => {
    setSelectedIds((prev) => selectionReducer(prev, { type: "toggle", id }));
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) =>
      selectionReducer(prev, {
        type: "select-all",
        allIds: connections.map((entry) => entry.id),
      }),
    );
  }, [connections]);

  const toggleActive = useCallback(
    async (id, isActive) => {
      try {
        const res = await fetch(`/api/providers/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive }),
        });
        if (res.ok) {
          setConnections((prev) =>
            prev.map((entry) => (entry.id === id ? { ...entry, isActive } : entry)),
          );
        } else {
          fail("Failed to update connection.");
        }
      } catch (error) {
        fail("Failed to update connection.", error);
      }
    },
    [fail],
  );

  const updateProxy = useCallback(
    async (id, proxyPoolId) => {
      try {
        const res = await fetch(`/api/providers/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ proxyPoolId: proxyPoolId || null }),
        });
        if (!res.ok) {
          fail("Failed to update proxy.");
          return;
        }
        setConnections((prev) =>
          prev.map((entry) =>
            entry.id === id
              ? {
                  ...entry,
                  providerSpecificData: {
                    ...entry.providerSpecificData,
                    proxyPoolId: proxyPoolId || null,
                  },
                }
              : entry,
          ),
        );
      } catch (error) {
        fail("Failed to update proxy.", error);
      }
    },
    [fail],
  );

  const applyProxyAssignments = useCallback(
    async (assignments) => {
      setBulkProxyUpdating(true);
      try {
        let failed = 0;
        for (const { connectionId, proxyPoolId } of assignments) {
          try {
            const res = await fetch(`/api/providers/${connectionId}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ proxyPoolId }),
            });
            if (!res.ok) failed += 1;
          } catch (error) {
            console.log("Error applying proxy for", connectionId, error);
            failed += 1;
          }
        }
        if (failed > 0) fail(`Updated with ${failed} failed request(s).`);
        await fetchConnections();
        setBulkProxyOpen(false);
      } finally {
        setBulkProxyUpdating(false);
      }
    },
    [fail, fetchConnections],
  );

  const persistOrder = useCallback(
    async (next, previous) => {
      setConnections(next);
      // Sequential 1-based PUTs: the server renumbers to dense 1..n with a
      // newest-updated tie-break on every priority PUT, so concurrent writes
      // can arrive out of order and scramble ties. Awaiting each PUT in the
      // intended final order keeps the server result deterministic.
      try {
        const previousById = new Map(previous.map((entry) => [entry.id, entry.priority]));
        for (const entry of next) {
          if (previousById.get(entry.id) === entry.priority) continue;
          const res = await fetch(`/api/providers/${entry.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ priority: entry.priority }),
          });
          if (!res.ok) {
            fail("Failed to save new order.");
            await fetchConnections();
            return;
          }
        }
      } catch (error) {
        fail("Failed to save new order.", error);
        await fetchConnections();
      }
    },
    [fail, fetchConnections],
  );

  /**
   * Move within the priority-sorted list (shared by DnD and the up/down
   * fallback). `connections` is always kept in priority order.
   */
  const moveConnection = useCallback(
    async (fromIndex, toIndex) => {
      const next = reorderConnections(connections, fromIndex, toIndex);
      if (next === connections) return;
      await persistOrder(next, connections);
    },
    [connections, persistOrder],
  );

  const removeConnections = useCallback(
    async (ids) => {
      let failed = 0;
      for (const id of ids) {
        try {
          const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
          if (!res.ok) failed += 1;
        } catch (error) {
          console.log("Error deleting connection:", error);
          failed += 1;
        }
      }
      setConnections((prev) => prev.filter((entry) => !ids.includes(entry.id)));
      setSelectedIds((prev) =>
        selectionReducer(prev, {
          type: "prune",
          existingIds: connections.map((entry) => entry.id).filter((id) => !ids.includes(id)),
        }),
      );
      if (failed > 0) fail(`Deleted ${ids.length - failed} connection(s), ${failed} failed.`);
    },
    [connections, fail],
  );

  const confirmDelete = useCallback(
    (id) => {
      setConfirmState({
        title: "Delete Connection",
        message: "Delete this connection?",
        onConfirm: async () => {
          setConfirmState(null);
          await removeConnections([id]);
        },
      });
    },
    [removeConnections],
  );

  const confirmBulkDelete = useCallback(() => {
    setSelectedIds((prev) => {
      if (prev.length === 0) return prev;
      const count = prev.length;
      const ids = [...prev];
      setConfirmState({
        title: `Delete ${count} Connection${count > 1 ? "s" : ""}`,
        message: `Delete ${count} connection${count > 1 ? "s" : ""}? This cannot be undone.`,
        onConfirm: async () => {
          setConfirmState(null);
          await removeConnections(ids);
        },
      });
      return prev;
    });
  }, [removeConnections]);

  const runOneByOne = useCallback(async () => {
    if (oneByOne.running || connections.length === 0) return;
    stopRef.current = false;
    const queued = Object.fromEntries(
      connections.map((entry) => [entry.id, { state: "queued", error: null }]),
    );
    setOneByOne({
      running: true,
      stopping: false,
      currentId: null,
      results: queued,
      summary: { total: connections.length, completed: 0, passed: 0, failed: 0, stopped: false },
    });
    let passed = 0;
    let failed = 0;
    try {
      for (let index = 0; index < connections.length; index += 1) {
        if (stopRef.current) {
          setOneByOne((prev) => ({
            ...prev,
            summary: {
              total: connections.length,
              completed: index,
              passed,
              failed,
              stopped: true,
            },
          }));
          break;
        }
        const connection = connections[index];
        setOneByOne((prev) => ({
          ...prev,
          currentId: connection.id,
          results: { ...prev.results, [connection.id]: { state: "testing", error: null } },
        }));
        try {
          const res = await fetch(`/api/providers/${connection.id}/test`, { method: "POST" });
          const data = await res.json().catch(() => ({}));
          const valid = !!data.valid;
          if (valid) passed += 1;
          else failed += 1;
          setOneByOne((prev) => ({
            ...prev,
            results: {
              ...prev.results,
              [connection.id]: {
                state: valid ? "success" : "failed",
                error: valid ? null : data.error || null,
              },
            },
          }));
        } catch (error) {
          failed += 1;
          setOneByOne((prev) => ({
            ...prev,
            results: {
              ...prev.results,
              [connection.id]: { state: "failed", error: error.message || "Test failed" },
            },
          }));
        }
        setOneByOne((prev) => ({
          ...prev,
          summary: {
            total: connections.length,
            completed: index + 1,
            passed,
            failed,
            stopped: false,
          },
        }));
        if (index < connections.length - 1) await sleep(ONE_BY_ONE_DELAY_MS);
      }
    } finally {
      stopRef.current = false;
      setOneByOne((prev) => ({ ...prev, running: false, stopping: false, currentId: null }));
    }
  }, [connections, oneByOne.running]);

  const stopOneByOne = useCallback(() => {
    if (!oneByOne.running) return;
    stopRef.current = true;
    setOneByOne((prev) => ({ ...prev, stopping: true }));
  }, [oneByOne.running]);

  return {
    connections,
    setConnections,
    proxyPools,
    selectedIds,
    setSelectedIds,
    allSelected:
      connections.length > 0 && connections.every((entry) => selectedIds.includes(entry.id)),
    confirmState,
    setConfirmState,
    bulkProxyOpen,
    setBulkProxyOpen,
    bulkProxyUpdating,
    oneByOne,
    fetchConnections,
    toggleSelect,
    toggleSelectAll,
    toggleActive,
    updateProxy,
    applyProxyAssignments,
    moveConnection,
    removeConnections,
    confirmDelete,
    confirmBulkDelete,
    runOneByOne,
    stopOneByOne,
  };
}
