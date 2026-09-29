/**
 * Notification Store — Zustand-based global toast notification system.
 * Centralized feedback for dashboard actions.
 */

import { create } from "zustand";

let idCounter = 0;

/** Error announcements interrupt politely announced status updates. */
export const toastRole = (type) => (type === "error" ? "alert" : "status");

export const useNotificationStore = create((set, get) => ({
  notifications: [],

  addNotification: (notification) => {
    const id = ++idCounter;
    const entry = {
      id,
      type: notification.type || "info",
      message: notification.message,
      title: notification.title || null,
      action: notification.action ?? null,
      accent: notification.accent ?? null,
      duration: notification.duration ?? 5000,
      dismissible: notification.dismissible ?? true,
      createdAt: Date.now(),
    };

    set((s) => ({ notifications: [...s.notifications, entry] }));

    // Auto-dismiss
    if (entry.duration > 0) {
      setTimeout(() => get().removeNotification(id), entry.duration);
    }

    return id;
  },

  removeNotification: (id) => {
    set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) }));
  },

  clearAll: () => set({ notifications: [] }),

  success: (message, options) => get().addNotification(toastInput("success", message, options)),
  error: (message, options) =>
    get().addNotification({ duration: 8000, ...toastInput("error", message, options) }),
  warning: (message, options) => get().addNotification(toastInput("warning", message, options)),
  info: (message, options) => get().addNotification(toastInput("info", message, options)),
}));

/**
 * Keep the legacy `(message, title)` call shape while accepting
 * `(message, { title, action, duration, dismissible })`.
 */
function toastInput(type, message, options) {
  if (typeof options === "string") return { type, message, title: options };
  const input = { type, message, ...(options || {}) };
  const { action } = input;
  if (
    action != null &&
    (typeof action.label !== "string" || !action.label || typeof action.onSelect !== "function")
  ) {
    throw new TypeError("notification action needs a label and onSelect function");
  }
  return input;
}
