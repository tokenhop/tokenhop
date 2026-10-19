"use client";

import PropTypes from "prop-types";
import { useEffect, useId, useRef, useState } from "react";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";
// Direct file imports (not the barrel) keep this leaf free of cycles.
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Popover from "@/shared/components/Popover";
import { cn } from "@/shared/utils/cn";
import { localTodayKey, parseDateRange } from "@/shared/utils/period";

/** Day key `days` calendar days before `todayKey` (setDate, so DST keeps whole days). */
function daysBefore(todayKey, days) {
  const [y, m, d] = todayKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() - days);
  return localTodayKey(date.getTime());
}

/** Local-midnight Date for a `YYYY-MM-DD` key (never UTC parsing, which shifts the day). */
function keyToDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Short localized label for an inclusive range, e.g. "Sep 1 – Oct 19". The
 * year shows only when the range leaves the current year.
 * @param {{from: string, to: string}} range
 * @param {string|null} locale
 * @returns {string}
 */
export function formatRangeLabel(range, locale) {
  const from = keyToDate(range.from);
  const to = keyToDate(range.to);
  const thisYear = new Date().getFullYear();
  const options = { month: "short", day: "numeric" };
  if (from.getFullYear() !== thisYear || to.getFullYear() !== thisYear) options.year = "numeric";
  let format;
  try {
    format = new Intl.DateTimeFormat(locale || undefined, options);
  } catch {
    format = new Intl.DateTimeFormat("en", options);
  }
  if (range.from === range.to) return format.format(from);
  return typeof format.formatRange === "function"
    ? format.formatRange(from, to)
    : `${format.format(from)} – ${format.format(to)}`;
}

/** Which input a validation reason belongs to, so the message sits under it. */
function errorField(reason, from) {
  if (reason === "range_missing") return from ? "to" : "from";
  if (reason === "range_format") return /^\d{4}-\d{2}-\d{2}$/.test(from) ? "to" : "from";
  return "to";
}

/**
 * Custom date-range control for the Usage period bar: a trigger that sits
 * next to the period segmented control and opens a popover with From/To day
 * inputs. Kept out of the segmented control on purpose: that control selects
 * on arrow keys, which would open the picker while a keyboard user is just
 * moving past it.
 *
 * Validation mirrors the server (`parseDateRange`): both days required, from
 * on or before to, no future end day, at most 366 days. Errors show after the
 * first Apply and then update as the user edits.
 *
 * @param {object} props
 * @param {{from: string, to: string}|null} props.range Active custom range, or null.
 * @param {(from: string, to: string) => void} props.onApply Called with a valid range.
 * @param {string} [props.className] Classes on the trigger.
 */
export default function CustomRangePicker({ range, onApply, className }) {
  const triggerId = useId();
  const [open, setOpen] = useState(false);
  const [locale, setLocale] = useState(null);
  const [draft, setDraft] = useState({ from: "", to: "" });
  const [today, setToday] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const fromRef = useRef(null);
  const toRef = useRef(null);

  useEffect(() => {
    setLocale(getCurrentLocale());
    return onLocaleChange(() => setLocale(getCurrentLocale()));
  }, []);

  // Seed the draft each time the panel opens: the active range, else the last 7 days.
  const openPanel = (next) => {
    if (next) {
      const todayKey = localTodayKey();
      setToday(todayKey);
      setDraft(range ?? { from: daysBefore(todayKey, 6), to: todayKey });
      setShowErrors(false);
    }
    setOpen(next);
  };

  // Focus the first day once the panel is placed. It renders hidden until
  // measured (and the portal mounts later on first open), and a hidden input
  // can't take focus, so retry each frame until focus sticks (bounded).
  useEffect(() => {
    if (!open) return undefined;
    let frame = 0;
    let attempts = 0;
    const tryFocus = () => {
      const input = fromRef.current;
      input?.focus();
      if (document.activeElement === input || ++attempts >= 30) return;
      frame = requestAnimationFrame(tryFocus);
    };
    frame = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const closeAndRefocus = () => {
    setOpen(false);
    requestAnimationFrame(() => document.getElementById(triggerId)?.focus());
  };

  const result = parseDateRange(draft.from, draft.to, today || localTodayKey());
  const invalidField = !result.ok && showErrors ? errorField(result.reason, draft.from) : null;

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!result.ok) {
      setShowErrors(true);
      // Move focus to the field at fault so its message is announced.
      const field = errorField(result.reason, draft.from);
      (field === "from" ? fromRef : toRef).current?.focus();
      return;
    }
    onApply(result.from, result.to);
    closeAndRefocus();
  };

  const active = Boolean(range);
  const label = active ? formatRangeLabel(range, locale) : null;

  const trigger = (
    <button
      id={triggerId}
      type="button"
      className={cn(
        "group inline-flex shrink-0 items-center rounded-lg border border-line bg-raised p-1",
        "focus-visible:outline-none focus-visible:shadow-focus",
        className,
      )}
    >
      <span
        className={cn(
          "inline-flex h-9 max-w-[14rem] items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors duration-200 motion-reduce:transition-none",
          active ? "bg-text text-bg" : "text-muted group-hover:text-text",
        )}
      >
        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
          date_range
        </span>
        {active ? (
          <>
            <span className="sr-only">Custom range</span>
            <span className="truncate tabular-nums">{label}</span>
          </>
        ) : (
          <span>Custom</span>
        )}
      </span>
    </button>
  );

  return (
    <Popover
      trigger={trigger}
      open={open}
      onOpenChange={openPanel}
      placement="bottom"
      aria-label="Custom date range"
      className="w-[min(22rem,calc(100vw-16px))]"
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-text">Custom range</p>
          <p className="flex items-start gap-1.5 text-xs text-muted">
            <span className="material-symbols-outlined text-[14px] leading-4" aria-hidden="true">
              schedule
            </span>
            <span>Dates use the server's local days.</span>
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
          <Input
            ref={fromRef}
            type="date"
            label="From"
            value={draft.from}
            max={(draft.to && draft.to < today ? draft.to : today) || undefined}
            onChange={(event) => setDraft((d) => ({ ...d, from: event.target.value }))}
            error={invalidField === "from" ? result.message : undefined}
            inputClassName="tabular-nums"
          />
          <Input
            ref={toRef}
            type="date"
            label="To"
            value={draft.to}
            min={draft.from || undefined}
            max={today || undefined}
            onChange={(event) => setDraft((d) => ({ ...d, to: event.target.value }))}
            error={invalidField === "to" ? result.message : undefined}
            inputClassName="tabular-nums"
          />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={closeAndRefocus}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm">
            Apply
          </Button>
        </div>
      </form>
    </Popover>
  );
}

CustomRangePicker.propTypes = {
  range: PropTypes.shape({
    from: PropTypes.string.isRequired,
    to: PropTypes.string.isRequired,
  }),
  onApply: PropTypes.func.isRequired,
  className: PropTypes.string,
};
