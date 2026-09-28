"use client";

import PropTypes from "prop-types";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/shared/utils/cn";
import { copyTextToClipboard } from "./formPrimitives";

/**
 * Signal mono value with a copy button. Announces "Copied" (or the failure)
 * via a polite live region; the clipboard failure path keeps the button honest.
 */
export default function CopyField({
  value,
  copyValue,
  label = "Copy to clipboard",
  className,
  ...props
}) {
  const [status, setStatus] = useState(null); // "copied" | "error"
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const announce = (next) => {
    setStatus(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(null), 2000);
  };

  const onCopy = async () => {
    try {
      await copyTextToClipboard(copyValue ?? value);
      announce("copied");
    } catch {
      announce("error");
    }
  };

  return (
    <div
      className={cn(
        "flex h-11 items-center gap-2 rounded-lg border border-line bg-raised ps-3 pe-1.5 transition-colors",
        "focus-within:border-coral focus-within:shadow-focus",
        className,
      )}
      {...props}
    >
      <code className="min-w-0 flex-1 truncate font-mono text-sm text-text">{value}</code>
      <button
        type="button"
        aria-label={label}
        onClick={onCopy}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-line/60 hover:text-text focus-visible:shadow-focus"
      >
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
          {status === "copied" ? "check" : status === "error" ? "error" : "content_copy"}
        </span>
      </button>
      <span aria-live="polite" className="sr-only">
        {status === "copied" ? "Copied" : status === "error" ? "Copy failed" : ""}
      </span>
    </div>
  );
}

CopyField.propTypes = {
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
  copyValue: PropTypes.string,
  label: PropTypes.string,
  className: PropTypes.string,
};
