"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { copyTextToClipboard } from "@/shared/components/formPrimitives";

/**
 * Copy to clipboard with truthful feedback. Awaits the write through the
 * shared helper, so a failed copy never announces success.
 * @param {number} resetDelay - Time in ms before resetting state (default: 2000)
 * Render `<CopyStatus copied={copied} error={error} />` (or use `message`)
 * near the trigger so the result is announced politely.
 * @returns {{ copied: string|null, error: string|null, message: string, copy: (text: string, id?: string) => Promise<boolean> }}
 */
export function useCopyToClipboard(resetDelay = 2000) {
  const [copied, setCopied] = useState(null);
  const [error, setError] = useState(null);
  const timeoutRef = useRef(null);
  const requestRef = useRef(0);

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  const copy = useCallback(
    async (text, id = "default") => {
      const request = ++requestRef.current;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      try {
        await copyTextToClipboard(text);
        if (request !== requestRef.current) return true;
        setCopied(id);
        setError(null);
        timeoutRef.current = setTimeout(() => {
          setCopied(null);
          setError(null);
        }, resetDelay);
        return true;
      } catch {
        if (request !== requestRef.current) return false;
        setCopied(null);
        setError(id);
        timeoutRef.current = setTimeout(() => {
          setCopied(null);
          setError(null);
        }, resetDelay);
        return false;
      }
    },
    [resetDelay],
  );

  const message = error != null ? "Couldn't copy" : copied != null ? "Copied" : "";

  return { copied, error, message, copy };
}
