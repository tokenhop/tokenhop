"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmModal } from "@/shared/components";
import { fetchJson } from "./tokenSaverApi";

/**
 * Headroom extras state machine: probe, extras list, install/uninstall with
 * log polling, active toggles with proxy restart.
 * @param {() => void} [onChanged] called after an active-toggle settings write
 * @returns {object} extras state + actions
 */
export function useHeadroomExtras(onChanged) {
  const [headroom, setHeadroom] = useState({ loading: true });
  const [available, setAvailable] = useState(["code", "ml"]);
  const [pendingExtras, setPendingExtras] = useState([]);
  const [extrasLoading, setExtrasLoading] = useState(false);
  const [extrasError, setExtrasError] = useState("");
  const [removingExtra, setRemovingExtra] = useState(null);
  const [installLog, setInstallLog] = useState("");
  const [confirm, setConfirm] = useState(null);
  const [restartingProxy, setRestartingProxy] = useState(false);
  const logPollRef = useRef(null);

  const refresh = useCallback(async () => {
    setHeadroom((s) => ({ ...s, loading: true }));
    try {
      const data = await fetchJson("/api/headroom/status");
      setHeadroom({ ...data, loading: false });
      if (!data?.installed) {
        setAvailable(["code", "ml"]);
        setPendingExtras([]);
        return;
      }
      try {
        const extras = await fetchJson("/api/headroom/extras");
        if (extras.version) setHeadroom((s) => ({ ...s, version: extras.version }));
        setAvailable(extras.available || ["code", "ml"]);
        setPendingExtras([]);
      } catch {
        setAvailable(["code", "ml"]);
        setPendingExtras([]);
      }
    } catch {
      setHeadroom({ installed: false, running: false, loading: false });
      setAvailable(["code", "ml"]);
      setPendingExtras([]);
    }
  }, []);

  const startLogPolling = useCallback(() => {
    setInstallLog("");
    if (logPollRef.current) clearInterval(logPollRef.current);
    const tick = async () => {
      try {
        const data = await fetchJson("/api/headroom/extras?log=1");
        if (typeof data.log === "string") setInstallLog(data.log);
      } catch {
        /* ignore transient poll errors */
      }
    };
    tick();
    logPollRef.current = setInterval(tick, 1500);
  }, []);

  const stopLogPolling = useCallback(() => {
    if (logPollRef.current) {
      clearInterval(logPollRef.current);
      logPollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopLogPolling(), [stopLogPolling]);

  const installConfirmed = useCallback(async () => {
    if (pendingExtras.length === 0) return;
    setExtrasLoading(true);
    setExtrasError("");
    startLogPolling();
    try {
      const data = await fetchJson("/api/headroom/extras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extras: pendingExtras }),
      });
      if (data.version) setHeadroom((s) => ({ ...s, version: data.version }));
      setPendingExtras([]);
      await refresh();
    } catch (error) {
      setExtrasError(error.message);
    } finally {
      stopLogPolling();
      setExtrasLoading(false);
    }
  }, [pendingExtras, startLogPolling, stopLogPolling, refresh]);

  const removeConfirmed = useCallback(
    async (extra) => {
      setRemovingExtra(extra);
      setExtrasError("");
      startLogPolling();
      try {
        const data = await fetchJson("/api/headroom/extras", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ extras: [extra] }),
        });
        if (data.version) setHeadroom((s) => ({ ...s, version: data.version }));
        await refresh();
      } catch (error) {
        setExtrasError(error.message);
      } finally {
        stopLogPolling();
        setRemovingExtra(null);
      }
    },
    [startLogPolling, stopLogPolling, refresh],
  );

  const install = useCallback(() => {
    if (pendingExtras.length === 0) return;
    if (pendingExtras.includes("ml")) {
      setConfirm({
        title: "Install [ml]",
        message: "[ml] downloads ~1 GB (torch + huggingface-hub). Continue?",
        confirmText: "Install",
        variant: "default",
        onConfirm: installConfirmed,
      });
      return;
    }
    installConfirmed();
  }, [pendingExtras, installConfirmed]);

  const remove = useCallback(
    (extra) => {
      setConfirm({
        title: `Remove [${extra}]`,
        message: `Remove [${extra}] and its packages?`,
        confirmText: "Remove",
        variant: "danger",
        onConfirm: () => removeConfirmed(extra),
      });
    },
    [removeConfirmed],
  );

  const toggleActive = useCallback(
    async (extra, value) => {
      setExtrasError("");
      const key = extra === "code" ? "headroomCodeAware" : "headroomKompress";
      try {
        await fetchJson("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [key]: value }),
        });
        onChanged?.();
      } catch (error) {
        setExtrasError(error.message);
        return;
      }
      if (!headroom.running) return;
      setRestartingProxy(true);
      try {
        await fetchJson("/api/headroom/restart", { method: "POST" });
        await refresh();
      } catch (error) {
        setExtrasError(error.message);
      } finally {
        setRestartingProxy(false);
      }
    },
    [headroom.running, onChanged, refresh],
  );

  const confirmDialog = confirm && (
    <ConfirmModal
      isOpen
      onClose={() => setConfirm(null)}
      onConfirm={() => {
        const fn = confirm.onConfirm;
        setConfirm(null);
        fn?.();
      }}
      title={confirm.title}
      message={confirm.message}
      confirmText={confirm.confirmText}
      variant={confirm.variant}
    />
  );

  return {
    headroom,
    available,
    pendingExtras,
    togglePending: (extra) =>
      setPendingExtras((cur) =>
        cur.includes(extra) ? cur.filter((e) => e !== extra) : [...cur, extra],
      ),
    install,
    remove,
    toggleActive,
    extrasLoading,
    extrasError,
    removingExtra,
    installLog,
    restartingProxy,
    refresh,
    confirmDialog,
  };
}
