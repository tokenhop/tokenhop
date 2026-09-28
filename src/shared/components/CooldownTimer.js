"use client";

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";

/**
 * Cooldown countdown. Single shared copy; all dashboard surfaces import this.
 *
 * @param {object} props
 * @param {string} props.until ISO timestamp when the cooldown ends
 * @param {() => void} [props.onExpire] called once when a live countdown reaches zero
 */
export default function CooldownTimer({ until, onExpire }) {
  const [remaining, setRemaining] = useState("");
  const wasLive = useRef(false);

  useEffect(() => {
    const updateRemaining = () => {
      const diff = new Date(until).getTime() - Date.now();
      if (diff <= 0) {
        setRemaining("");
        if (wasLive.current) {
          wasLive.current = false;
          onExpire?.();
        }
        return;
      }
      wasLive.current = true;
      const secs = Math.floor(diff / 1000);
      if (secs < 60) {
        setRemaining(`${secs}s`);
      } else if (secs < 3600) {
        setRemaining(`${Math.floor(secs / 60)}m ${secs % 60}s`);
      } else {
        const hrs = Math.floor(secs / 3600);
        const mins = Math.floor((secs % 3600) / 60);
        setRemaining(`${hrs}h ${mins}m`);
      }
    };

    updateRemaining();
    const interval = setInterval(updateRemaining, 1000);
    return () => clearInterval(interval);
  }, [until, onExpire]);

  if (!remaining) return null;

  return (
    <span className="font-mono text-xs text-warn" aria-live="off">
      {remaining} left
    </span>
  );
}

CooldownTimer.propTypes = {
  until: PropTypes.string.isRequired,
  onExpire: PropTypes.func,
};
