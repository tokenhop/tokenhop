"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";
import {
  connectionReducer,
  initialConnectionState,
  initialConsoleBufferState,
  parseConsoleLine,
  pauseBufferReducer,
  retryDelayMs,
} from "@/shared/utils/consoleLog";

const STREAM_URL = "/api/translator/console-logs/stream";
const SNAPSHOT_URL = "/api/translator/console-logs";
const MAX_LINES = CONSOLE_LOG_CONFIG.maxLines;

/** Manages the console SSE lifecycle. Hidden tabs close the stream; visible tabs fetch a catch-up snapshot. */
export default function useConsoleStream() {
  const [buffer, dispatchBuffer] = useReducer(pauseBufferReducer, initialConsoleBufferState);
  const [connection, dispatchConnection] = useReducer(connectionReducer, initialConnectionState);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [visibilityEpoch, setVisibilityEpoch] = useState(0);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const streamRef = useRef(null);
  const retryRef = useRef(null);
  const retryAttemptRef = useRef(0);
  const activeRef = useRef(false);
  const snapshotVersionRef = useRef(0);

  // Request a fresh snapshot after returning from a hidden tab. The version
  // invalidates any fetch that was in flight when the tab was hidden.
  useEffect(() => {
    const onVisibility = () => {
      snapshotVersionRef.current += 1;
      if (document.hidden) {
        activeRef.current = false;
        streamRef.current?.close();
        streamRef.current = null;
        clearTimeout(retryRef.current);
        retryAttemptRef.current = 0;
        dispatchConnection({ type: "hidden" });
      } else {
        setVisibilityEpoch((value) => value + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (document.hidden) return;
    let cancelled = false;
    activeRef.current = true;
    const version = snapshotVersionRef.current;
    const abort = new AbortController();
    let snapshotPending = true;
    const pendingEvents = [];
    let initialEvent = null;
    let snapshotRaw = [];

    const handleEvent = (msg) => {
      if (msg.type === "line" && typeof msg.line === "string") {
        dispatchBuffer({
          type: "append",
          lines: [parseConsoleLine(msg.line)],
          maxLines: MAX_LINES,
        });
      } else if (msg.type === "lines" && Array.isArray(msg.lines)) {
        dispatchBuffer({
          type: "append",
          lines: msg.lines.map(parseConsoleLine),
          maxLines: MAX_LINES,
        });
      } else if (msg.type === "clear") {
        dispatchBuffer({ type: "clear" });
      }
    };

    const openStream = () => {
      if (!activeRef.current || document.hidden) return;
      dispatchConnection({ type: "connect" });
      const es = new EventSource(STREAM_URL);
      streamRef.current = es;
      es.onopen = () => {
        if (!activeRef.current) return;
        retryAttemptRef.current = 0;
        dispatchConnection({ type: "open" });
        setLoadError("");
      };
      es.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          setLoadError("Received an invalid log event. Reconnect to try again.");
          return;
        }
        if (msg.type === "init" && Array.isArray(msg.logs)) {
          // The stream init is a snapshot, not an append. Use it if the HTTP
          // catch-up failed, and never clear a paused view on reconnect.
          initialEvent = msg.logs;
          return;
        }
        if (snapshotPending) pendingEvents.push(msg);
        else handleEvent(msg);
      };
      es.onerror = () => {
        es.close();
        if (!activeRef.current || document.hidden) return;
        dispatchConnection({ type: "error" });
        retryAttemptRef.current += 1;
        const delay = retryDelayMs(retryAttemptRef.current);
        clearTimeout(retryRef.current);
        retryRef.current = setTimeout(openStream, delay);
      };
    };

    openStream();
    const catchUp = async () => {
      try {
        const res = await fetch(SNAPSHOT_URL, { cache: "no-store", signal: abort.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.success || !Array.isArray(data.logs)) throw new Error("Invalid log snapshot");
        if (cancelled || version !== snapshotVersionRef.current) return;
        snapshotRaw = Array.isArray(data.logs) ? data.logs.slice(-MAX_LINES) : [];
        dispatchBuffer({
          type: "snapshot",
          lines: snapshotRaw.map(parseConsoleLine),
          maxLines: MAX_LINES,
        });
        setHasSnapshot(true);
        setLoadError("");
      } catch (error) {
        if (cancelled || version !== snapshotVersionRef.current) return;
        if (initialEvent) {
          snapshotRaw = initialEvent.slice(-MAX_LINES);
          dispatchBuffer({
            type: "snapshot",
            lines: snapshotRaw.map(parseConsoleLine),
            maxLines: MAX_LINES,
          });
          setHasSnapshot(true);
        } else {
          setLoadError(`Could not load console history: ${error.message}. Try reconnecting.`);
        }
      } finally {
        if (!cancelled && version === snapshotVersionRef.current) {
          snapshotPending = false;
          // De-duplicate: events received after the HTTP snapshot may already be
          // in it. Snapshot raw lines are the source of truth here.
          const queued = pendingEvents.splice(0);
          if (queued.length > 0) {
            const existing = new Set(snapshotRaw);
            for (const msg of queued) {
              if (msg.type === "line" && existing.has(msg.line)) continue;
              if (msg.type === "lines" && msg.lines.every((line) => existing.has(line))) continue;
              handleEvent(msg);
            }
          }
          setLoading(false);
        }
      }
    };
    catchUp();
    return () => {
      cancelled = true;
      activeRef.current = false;
      abort.abort();
      clearTimeout(retryRef.current);
      streamRef.current?.close();
      streamRef.current = null;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: visibilityEpoch intentionally restarts the stream on tab return or manual reconnect.
  }, [visibilityEpoch]);

  return {
    buffer,
    connection,
    dispatchBuffer,
    loadError,
    loading,
    hasSnapshot,
    reconnect: () => setVisibilityEpoch((value) => value + 1),
  };
}
