"use client";

import { useEffect } from "react";

/**
 * Close an open popup on outside pointer-down or Escape. Escape also returns
 * focus to the trigger; outside clicks leave focus where the user clicked.
 * Clicks on the trigger are ignored so its own toggle handler wins.
 */
export default function useMenuDismiss(isOpen, onClose, triggerRef, panelRef) {
  useEffect(() => {
    if (!isOpen) return undefined;

    const inside = (target) =>
      panelRef.current?.contains(target) || triggerRef.current?.contains(target);

    const handlePointerDown = (event) => {
      if (!inside(event.target)) onClose();
    };
    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
      triggerRef.current?.focus();
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose, triggerRef, panelRef]);
}
