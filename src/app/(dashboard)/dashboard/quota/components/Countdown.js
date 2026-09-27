"use client";

import PropTypes from "prop-types";
import { useEffect, useState } from "react";

/**
 * Countdown leaf: ticks once a second from a `to` timestamp so the page and
 * cards never re-render on countdown ticks (YAN-398).
 *
 * @param {{ to?: number|null, className?: string, label?: string, countdownId?: string }} props
 * Visible seconds tick `aria-hidden`; screen readers get quiet `countdownId` region
 * referenced by `aria-describedby`.
 */
export default function Countdown({
  to = null,
  className = "",
  label = "Next refresh in",
  countdownId,
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!to) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [to]);

  if (!to) return null;
  const seconds = Math.max(0, Math.ceil((to - now) / 1000));
  // Quiet region changes once a minute, not every tick.
  const minutes = Math.ceil(seconds / 60);
  return (
    <>
      <span className={`font-mono text-xs text-muted tabular-nums ${className}`} aria-hidden="true">
        {label} {seconds}s
      </span>
      <span id={countdownId} className="sr-only" aria-live="off">
        {label} {minutes} minute{minutes === 1 ? "" : "s"}
      </span>
    </>
  );
}

Countdown.propTypes = {
  to: PropTypes.number,
  className: PropTypes.string,
  label: PropTypes.string,
  countdownId: PropTypes.string,
};
