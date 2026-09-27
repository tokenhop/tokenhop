"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  leaveOverSentinel,
  requestComboNavigation,
  shouldGuardLinkClick,
  takeDeferredForward,
} from "./comboSave";

/**
 * Warn before discarding unsaved combo edits: in-page requests, same-origin
 * links, browser Back/Forward, tab close and guarded programmatic routes
 * (command palette, g chords).
 *
 * While dirty, one same-URL history entry is pushed natively (bypassing the
 * App Router patch) so Back lands on an identical URL instead of leaving.
 * The popstate then opens the dialog; confirming discards and goes back for
 * real. Keep editing re-arms the entry. A stale sentinel after a Save is
 * skipped on the next Back.
 *
 * @param {boolean} dirty Whether the open draft differs from the saved combo.
 * @param {() => void} onDiscard Resets the draft before a confirmed Back.
 * @returns {{ request: (action: () => void) => void, requestNavigation: (action: () => void) => void, pending: boolean, confirm: () => void, cancel: () => void }}
 */
export default function useUnsavedComboGuard(dirty, onDiscard) {
  const router = useRouter();
  const [pending, setPending] = useState(null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const onDiscardRef = useRef(onDiscard);
  onDiscardRef.current = onDiscard;
  const pendingRef = useRef(false);
  // armed: same-URL Back sentinel is on the stack; pendingForward: a leave
  // waiting for that sentinel's popstate.
  const sentinelRef = useRef({ armed: false, pendingForward: null });
  const skipPopRef = useRef(false);
  const advanceBackRef = useRef(() => window.setTimeout(() => window.history.back(), 0));

  const request = (action) => {
    if (dirtyRef.current) setPending(() => action);
    else action();
  };
  // Leave the page without stacking history: pop the same-URL Back sentinel
  // first (if armed), then run the navigation from the popstate handler.
  const leave = (action) =>
    leaveOverSentinel(sentinelRef.current, () => window.history.back(), action);
  const requestNavigation = (action, href) => {
    // Selecting the combo already open is a no-op, not a discard request.
    if (
      href &&
      !sentinelRef.current.pendingForward &&
      new URL(href, window.location.href).href === window.location.href
    )
      return;
    requestComboNavigation(
      dirtyRef.current,
      request,
      () => onDiscardRef.current?.(),
      () => leave(action),
    );
  };
  const confirm = () => {
    const action = pending;
    setPending(null);
    action?.();
  };
  useEffect(() => {
    pendingRef.current = !!pending;
  }, [pending]);

  // Arm the Back trap whenever there are unsaved edits and no open dialog.
  useEffect(() => {
    if (!dirty || pending || sentinelRef.current.armed) return;
    History.prototype.pushState.call(
      window.history,
      window.history.state,
      "",
      window.location.href,
    );
    sentinelRef.current.armed = true;
  }, [dirty, pending]);

  useEffect(() => {
    const beforeUnload = (event) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const onClick = (event) => {
      if (!dirtyRef.current) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (
        !shouldGuardLinkClick(
          event,
          {
            href: link?.href,
            target: link?.target,
            hasDownload: link?.hasAttribute("download"),
          },
          window.location.href,
          window.location.origin,
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setPending(() => () => {
        // Discard first: keeps one confirm for in-app links. Draft resets,
        // the URL effect then sees a clean page and selects the target.
        onDiscardRef.current?.();
        const next = new URL(link.href, window.location.href);
        leave(() => router.push(`${next.pathname}${next.search}${next.hash}`));
      });
    };
    const onPopState = () => {
      // A confirmed leave popped the same-URL sentinel first, so history
      // grows by one entry only.
      const forward = takeDeferredForward(sentinelRef.current);
      if (forward) {
        forward();
        return;
      }
      if (skipPopRef.current) {
        skipPopRef.current = false;
        return;
      }
      if (!sentinelRef.current.armed && !pendingRef.current) return;
      sentinelRef.current.armed = false;
      if (!dirtyRef.current) {
        // The extra sentinel entry becomes stale after Save. Rewind over it
        // without going back twice.
        if (!pendingRef.current) {
          skipPopRef.current = true;
          advanceBackRef.current();
        }
        return;
      }
      setPending(() => () => {
        onDiscardRef.current?.();
        skipPopRef.current = true;
        advanceBackRef.current();
      });
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPopState);
    };
  }, [router]);

  return {
    request,
    requestNavigation,
    pending: !!pending,
    confirm,
    cancel: () => setPending(null),
  };
}
