"use client";

import PropTypes from "prop-types";
import { useEffect, useRef, useState } from "react";
import SettingRow from "@/shared/components/SettingRow";
import Select from "@/shared/components/Select";
import Callout from "@/shared/components/Callout";
import { ConfirmDialog } from "@/shared/components/Modal";
import { translate } from "@/i18n/runtime";
import { useSettingsField } from "../useSettingsField";

const KEY = "usageHistoryRetentionDays";
const DAY_MS = 86_400_000;

// `0` keeps every row; the server accepts 0 or an integer 2..3650.
const RETENTION_OPTIONS = [
  { value: 0, label: "Keep forever" },
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 60, label: "60 days" },
  { value: 90, label: "90 days" },
  { value: 180, label: "180 days" },
  { value: 365, label: "365 days" },
];

const fill = (template, vars) =>
  String(template).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/** Presets plus the stored value when it isn't one of them (set via import/API). */
export function retentionOptions(current) {
  const days = Number(current);
  if (!Number.isInteger(days) || RETENTION_OPTIONS.some((o) => o.value === days)) {
    return RETENTION_OPTIONS;
  }
  const custom = { value: days, label: fill(translate("{days} days"), { days }) };
  return [...RETENTION_OPTIONS, custom].sort((a, b) => a.value - b.value);
}

/**
 * Whether moving from `current` to `next` deletes rows sooner: any limit after
 * Keep forever (0), or a shorter limit. Longer or forever never deletes more.
 */
export function shortensRetention(current, next) {
  if (next === 0) return false;
  return current === 0 || next < current;
}

/** 1536 -> "1.5 KB"; null when the server didn't report a size. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (bytes == null || !Number.isFinite(n) || n < 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** Size + row count + oldest row from GET /api/settings/environment (fields may be absent). */
function useHistoryStats() {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/environment", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : {}))
      .then((data) => {
        if (!cancelled) setStats(data || {});
      })
      .catch(() => {
        if (!cancelled) setStats({});
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return stats;
}

function Stat({ label, value, note, loading }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-raised p-3">
      <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">{label}</dt>
      <dd className="mt-1">
        {loading ? (
          <span className="block h-7 w-20 animate-pulse rounded-md bg-line" aria-hidden="true" />
        ) : (
          <span className="block truncate font-display text-xl font-bold tabular-nums text-text">
            {value ?? "—"}
          </span>
        )}
        {!loading && note && <span className="mt-0.5 block text-xs text-muted">{note}</span>}
      </dd>
    </div>
  );
}

Stat.propTypes = {
  label: PropTypes.node.isRequired,
  value: PropTypes.node,
  note: PropTypes.node,
  loading: PropTypes.bool,
};

function oldestReadout(iso) {
  const time = iso ? new Date(iso).getTime() : Number.NaN;
  if (Number.isNaN(time)) return { value: null, note: null };
  const value = new Date(time).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const days = Math.max(0, Math.floor((Date.now() - time) / DAY_MS));
  const note =
    days === 0
      ? translate("Today")
      : fill(translate("{days} days ago"), { days: days.toLocaleString() });
  return { value, note };
}

/**
 * Settings → Data: how long per-request usage history is kept (YAN-424),
 * plus database size, row count and oldest entry. Instance setting, so the
 * caller only renders it for people who can manage the instance.
 */
export default function UsageHistoryRetention({ settings, onSettingsChange }) {
  const field = useSettingsField(KEY, settings?.[KEY] ?? 0, {
    onSaved: (value) => onSettingsChange?.({ [KEY]: value }),
  });
  const stats = useHistoryStats();
  const loading = stats === null;
  const rows = Number.isFinite(stats?.usageHistoryRows) ? stats.usageHistoryRows : null;
  const oldest = oldestReadout(stats?.usageHistoryOldest);
  const days = Number(field.value) || 0;
  // A shorter limit waits here for confirmation; cancel drops it, so the
  // select falls back to the saved value.
  const [pending, setPending] = useState(null);
  // The dialog keeps rendering while it closes; hold the last value so the
  // message never shows "older than  days".
  const lastPending = useRef(0);
  if (pending !== null) lastPending.current = pending;

  const choose = (next) => {
    if (next === days) return;
    if (shortensRetention(days, next)) setPending(next);
    else field.set(next);
  };

  return (
    <div className="rounded-2xl border border-line bg-panel p-5 shadow-card divide-y divide-line">
      <SettingRow
        label="Request history"
        description="How long to keep the details of each request."
        settingKey={KEY}
        control={
          <div className="w-56">
            <Select
              aria-label="Request history"
              options={retentionOptions(pending ?? days)}
              value={pending ?? days}
              onChange={(e) => choose(Number(e.target.value))}
              disabled={field.saving}
              placeholder={null}
            />
            {field.error && (
              <p className="mt-1 text-xs text-err" role="alert">
                {field.error}
              </p>
            )}
          </div>
        }
      />
      <div className="space-y-3 py-4">
        <Callout variant="info" icon="history" title="Daily totals are always kept">
          <p>
            Charts, long periods and budgets use daily totals, which are never deleted. With a limit
            set, older request details are removed in the background shortly after startup, then
            once a day. Savings, top combos and period comparisons only count requests still in
            history, and an API key with no recent requests may show an older “last used” date. The
            database file may not shrink, because freed space is reused.
          </p>
        </Callout>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-busy={loading || undefined}>
          <Stat
            label="Database size"
            value={formatBytes(stats?.databaseSizeBytes)}
            loading={loading}
          />
          <Stat
            label="Requests in history"
            value={
              rows == null
                ? null
                : `${rows.toLocaleString()}${stats?.usageHistoryRowsCapped ? "+" : ""}`
            }
            loading={loading}
          />
          <Stat
            label="Oldest entry"
            value={oldest.value}
            note={rows === 0 ? translate("No requests yet") : oldest.note}
            loading={loading}
          />
        </dl>
      </div>
      <ConfirmDialog
        isOpen={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => {
          field.set(pending);
          setPending(null);
        }}
        title="Delete older request details?"
        message={fill(
          translate(
            "Request details older than {days} days will be permanently deleted. Daily totals and budgets are kept.",
          ),
          { days: pending ?? lastPending.current },
        )}
        confirmText="Delete older details"
        variant="danger"
      />
    </div>
  );
}

UsageHistoryRetention.propTypes = {
  settings: PropTypes.object,
  onSettingsChange: PropTypes.func,
};
