"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { usePathname } from "next/navigation";
import { useNotificationStore } from "@/store/notificationStore";
import Sidebar from "../Sidebar";
import Header from "../Header";
import Drawer from "../Drawer";
import CommandPalette from "../CommandPalette";
import { CommandPaletteProvider } from "../CommandPaletteProvider";

function getToastStyle(type) {
  if (type === "success") {
    return { wrapper: "border-ok/30 bg-ok-bg text-ok", icon: "check_circle" };
  }
  if (type === "error") {
    return { wrapper: "border-err/30 bg-err-bg text-err", icon: "error" };
  }
  if (type === "warning") {
    return { wrapper: "border-warn/30 bg-warn-bg text-warn", icon: "warning" };
  }
  return { wrapper: "border-sky/30 bg-sky-bg text-sky", icon: "info" };
}

function Toast({ notification, onDismiss }) {
  const style = getToastStyle(notification.type);
  const isError = notification.type === "error";
  const onAction = () => {
    notification.action.onSelect();
    onDismiss();
  };
  return (
    <div
      role={isError ? "alert" : "status"}
      className={`rounded-xl border px-3 py-2 shadow-card backdrop-blur-sm ${style.wrapper}`}
    >
      <div className="flex items-start gap-2">
        <span className="material-symbols-outlined text-[18px] leading-5" aria-hidden="true">
          {style.icon}
        </span>
        <div className="min-w-0 flex-1">
          {notification.title ? (
            <p className="mb-0.5 text-xs font-semibold">{notification.title}</p>
          ) : null}
          <p className="whitespace-pre-wrap break-words text-xs">{notification.message}</p>
        </div>
        {notification.action ? (
          <button
            type="button"
            onClick={onAction}
            className="inline-flex h-6 shrink-0 items-center rounded-md border border-current px-2 text-xs font-semibold transition-colors hover:bg-line/60 focus-visible:outline-none focus-visible:shadow-focus"
          >
            {notification.action.label}
          </button>
        ) : null}
        {notification.dismissible ? (
          <button
            type="button"
            onClick={onDismiss}
            className="text-current/70 transition-colors hover:text-current"
            aria-label="Dismiss notification"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              close
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

Toast.propTypes = {
  notification: PropTypes.shape({
    id: PropTypes.number,
    type: PropTypes.string,
    title: PropTypes.string,
    message: PropTypes.string,
    action: PropTypes.shape({
      label: PropTypes.string.isRequired,
      onSelect: PropTypes.func.isRequired,
    }),
    dismissible: PropTypes.bool,
  }).isRequired,
  onDismiss: PropTypes.func.isRequired,
};

/**
 * Signal shell layout: skip link, desktop 248px sidebar, off-canvas drawer
 * on mobile, header + main landmarks, Signal-token toasts with aria-live,
 * and the basic-chat special layout preserved.
 *
 * @param {object} props
 * @param {React.ReactNode} props.children
 */
export default function DashboardLayout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname() || "";
  const notifications = useNotificationStore((state) => state.notifications);
  const removeNotification = useNotificationStore((state) => state.removeNotification);
  const isBasicChat = pathname === "/dashboard/basic-chat";

  return (
    <CommandPaletteProvider>
      <div className="flex h-screen w-full overflow-hidden bg-bg text-text">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-[90] focus:rounded-lg focus:bg-panel focus:px-3 focus:py-2 focus:text-sm focus:shadow-card"
        >
          Skip to content
        </a>

        {/* Toasts — logical positioning (end-4), aria-live polite */}
        <div
          aria-live="polite"
          className="fixed end-4 top-4 z-[80] flex w-[min(92vw,380px)] flex-col gap-2"
        >
          {notifications.map((n) => (
            <Toast key={n.id} notification={n} onDismiss={() => removeNotification(n.id)} />
          ))}
        </div>

        {/* Desktop sidebar */}
        <div className="hidden lg:flex">
          <Sidebar />
        </div>

        {/* Mobile sidebar drawer */}
        <Drawer
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          side="start"
          width="nav"
          bare
          title="Navigation"
          id="mobile-sidebar-drawer"
        >
          <Sidebar inDrawer onClose={() => setSidebarOpen(false)} />
        </Drawer>

        {/* Main content */}
        <main
          id="main-content"
          tabIndex={-1}
          className="relative isolate flex h-full min-w-0 flex-1 flex-col"
        >
          <Header onMenuClick={() => setSidebarOpen(true)} sidebarOpen={sidebarOpen} />
          <div
            className={`custom-scrollbar flex-1 overflow-y-auto ${isBasicChat ? "flex flex-col overflow-hidden" : "p-4 lg:px-10 lg:pt-7 lg:pb-8"}`}
          >
            <div
              className={
                isBasicChat ? "flex h-full w-full flex-1 flex-col" : "mx-auto w-full max-w-7xl"
              }
            >
              {children}
            </div>
          </div>
        </main>
        <CommandPalette />
      </div>
    </CommandPaletteProvider>
  );
}

DashboardLayout.propTypes = {
  children: PropTypes.node,
};
