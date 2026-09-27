"use client";

import { useState, useEffect } from "react";
import Card from "./Card";

export default function RequestLogger() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);

  useEffect(() => {
    fetchLogs();
  }, []);

  useEffect(() => {
    let interval;
    if (autoRefresh) {
      interval = setInterval(() => {
        fetchLogs(false);
      }, 3000);
    }
    return () => clearInterval(interval);
  }, [autoRefresh]);

  const fetchLogs = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const res = await fetch("/api/usage/request-logs");
      if (res.ok) {
        const data = await res.json();
        setLogs(data);
      }
    } catch (error) {
      console.error("Failed to fetch logs:", error);
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Request Logs</h2>
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-muted flex items-center gap-2 cursor-pointer">
            <span>Auto Refresh (3s)</span>
            <div
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                autoRefresh ? "bg-toggle-on" : "bg-raised border border-line"
              }`}
            >
              <span
                className={`inline-block h-3 w-3 transform rounded-full transition-transform ${
                  autoRefresh ? "bg-toggle-knob-on translate-x-5" : "bg-muted translate-x-1"
                }`}
              />
            </div>
          </label>
        </div>
      </div>

      <Card className="overflow-hidden bg-black/5 dark:bg-black/20">
        <div className="p-0 overflow-x-auto max-h-[600px] overflow-y-auto font-mono text-xs">
          {loading && logs.length === 0 ? (
            <div className="p-8 text-center text-muted">Loading logs...</div>
          ) : logs.length === 0 ? (
            <div className="p-8 text-center text-muted">No logs recorded yet.</div>
          ) : (
            <table className="w-full text-left border-collapse whitespace-nowrap">
              <thead className="sticky top-0 bg-raised border-b border-line z-10">
                <tr>
                  <th className="px-3 py-2 border-r border-line">DateTime</th>
                  <th className="px-3 py-2 border-r border-line">Model</th>
                  <th className="px-3 py-2 border-r border-line">Provider</th>
                  <th className="px-3 py-2 border-r border-line">Account</th>
                  <th className="px-3 py-2 border-r border-line">In</th>
                  <th className="px-3 py-2 border-r border-line">Out</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/50">
                {logs.map((log, i) => {
                  const parts = log.split(" | ");
                  if (parts.length < 7) return null;

                  const status = parts[6];
                  const isPending = status.includes("PENDING");
                  const isFailed = status.includes("FAILED");
                  const isSuccess = status.includes("OK");

                  return (
                    <tr
                      key={i}
                      className={`hover:bg-coral-bg transition-colors ${isPending ? "bg-coral-bg" : ""}`}
                    >
                      <td className="px-3 py-1.5 border-r border-line text-muted">{parts[0]}</td>
                      <td className="px-3 py-1.5 border-r border-line font-medium">{parts[1]}</td>
                      <td className="px-3 py-1.5 border-r border-line">
                        <span className="px-1.5 py-0.5 rounded bg-raised border border-line text-[10px] uppercase font-bold">
                          {parts[2]}
                        </span>
                      </td>
                      <td
                        className="px-3 py-1.5 border-r border-line truncate max-w-[150px]"
                        title={parts[3]}
                      >
                        {parts[3]}
                      </td>
                      <td className="px-3 py-1.5 border-r border-line text-right text-coral-ink">
                        {parts[4]}
                      </td>
                      <td className="px-3 py-1.5 border-r border-line text-right text-ok">
                        {parts[5]}
                      </td>
                      <td
                        className={`px-3 py-1.5 font-bold ${
                          isSuccess
                            ? "text-ok"
                            : isFailed
                              ? "text-err"
                              : "text-coral-ink animate-pulse"
                        }`}
                      >
                        {status}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Card>
      <div className="text-[10px] text-muted italic">
        Logs are loaded from the request history database.
      </div>
    </div>
  );
}
