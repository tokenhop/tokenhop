"use client";
import { withWorkspace } from "./connectTarget";

import { useCallback, useEffect, useRef, useState } from "react";
import { refreshShellStatus } from "@/shared/hooks/useShellStatus";
import { useNotificationStore } from "@/store/notificationStore";

/**
 * Provider list mutations: enable/disable, batch and per-provider tests,
 * saving a new key and repairing a connection, plus the modal/busy state
 * those actions drive. Notifications use store selectors, so toasts never
 * re-render subscribers.
 */
export default function useProviderActions({ connections, setConnections, refreshData }) {
  const [testingMode, setTestingMode] = useState(null);
  const [testResults, setTestResults] = useState(null);
  const [isTestModalOpen, setIsTestModalOpen] = useState(false);
  const [testAccountsMode, setTestAccountsMode] = useState(null);
  const [addAccountEntry, setAddAccountEntry] = useState(null);
  const [addConnectionError, setAddConnectionError] = useState("");
  const [repairConnection, setRepairConnection] = useState(null);
  const notifySuccess = useNotificationStore((s) => s.success);
  const notifyError = useNotificationStore((s) => s.error);
  const notifyWarning = useNotificationStore((s) => s.warning);

  // Latest values without destabilizing callback identities: `connections`
  // changes on every list reload, and the in-flight flags flip during tests.
  const connectionsRef = useRef(connections);
  const testingModeRef = useRef(null);
  const testAccountsModeRef = useRef(null);

  useEffect(() => {
    connectionsRef.current = connections;
  }, [connections]);

  const handleToggleProvider = useCallback(
    async (providerId, authType, newActive) => {
      const authTypes = Array.isArray(authType) ? authType : [authType];
      const matches = (c) => c.provider === providerId && authTypes.includes(c.authType);
      const previous = connectionsRef.current;
      const providerConns = previous.filter(matches);
      setConnections((prev) => prev.map((c) => (matches(c) ? { ...c, isActive: newActive } : c)));
      const outcomes = await Promise.allSettled(
        providerConns.map((c) =>
          fetch(`/api/providers/${c.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ isActive: newActive }),
          }),
        ),
      );
      if (outcomes.some((o) => o.status === "rejected" || !o.value.ok)) {
        setConnections(previous);
        notifyError("Failed to update provider. Please try again.");
        refreshData();
      }
      refreshShellStatus();
    },
    [setConnections, notifyError, refreshData],
  );

  const handleBatchTest = useCallback(
    async (mode, providerId = null) => {
      if (testingModeRef.current) return;
      const marker = mode === "provider" ? providerId : mode;
      testingModeRef.current = marker;
      setTestingMode(marker);
      setTestResults(null);
      try {
        const res = await fetch("/api/providers/test-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, providerId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setTestResults({ error: data?.error || "Test request failed" });
          setIsTestModalOpen(true);
          notifyError("Provider test failed");
          refreshData();
          return;
        }
        setTestResults(data);
        setIsTestModalOpen(true);
        if (data.summary) {
          const { passed, failed, total } = data.summary;
          if (failed === 0) notifySuccess(`All ${total} tests passed`);
          else notifyWarning(`${passed}/${total} passed, ${failed} failed`);
        }
        refreshData();
      } catch {
        setTestResults({ error: "Test request failed" });
        setIsTestModalOpen(true);
        notifyError("Provider test failed");
      } finally {
        testingModeRef.current = null;
        setTestingMode(null);
      }
    },
    [refreshData, notifySuccess, notifyError, notifyWarning],
  );

  const handleTestAccounts = useCallback(
    async (entry) => {
      if (testAccountsModeRef.current) return;
      testAccountsModeRef.current = entry.id;
      setTestAccountsMode(entry.id);
      try {
        const res = await fetch("/api/providers/test-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "provider", providerId: entry.id }),
        });
        if (!res.ok) notifyError("Account test failed");
        refreshData();
      } catch {
        notifyError("Account test failed");
      } finally {
        testAccountsModeRef.current = null;
        setTestAccountsMode(null);
      }
    },
    [refreshData, notifyError],
  );

  const handleSaveApiKey = useCallback(
    async (formData, workspaceId = null) => {
      if (!addAccountEntry) return;
      setAddConnectionError("");
      try {
        const res = await fetch(withWorkspace("/api/providers", workspaceId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: addAccountEntry.id, ...formData }),
        });
        if (res.ok) {
          setAddAccountEntry(null);
          refreshData();
          return;
        }
        const data = await res.json().catch(() => ({}));
        setAddConnectionError(data?.error || "Failed to save connection");
      } catch {
        setAddConnectionError("Failed to save connection");
      }
    },
    [addAccountEntry, refreshData],
  );

  const handleRepairConnection = useCallback(
    async (formData) => {
      if (!repairConnection) return "Nothing to repair";
      try {
        const res = await fetch(`/api/providers/${repairConnection.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        if (res.ok) {
          setRepairConnection(null);
          refreshData();
          notifySuccess("Connection updated. Test it to confirm.");
          return null;
        }
        const data = await res.json().catch(() => ({}));
        return data.error || "Failed to save connection";
      } catch {
        return "Failed to save connection";
      }
    },
    [repairConnection, refreshData, notifySuccess],
  );

  return {
    testingMode,
    testResults,
    isTestModalOpen,
    setIsTestModalOpen,
    testAccountsMode,
    addAccountEntry,
    setAddAccountEntry,
    addConnectionError,
    setAddConnectionError,
    repairConnection,
    setRepairConnection,
    handleToggleProvider,
    handleBatchTest,
    handleTestAccounts,
    handleSaveApiKey,
    handleRepairConnection,
  };
}
