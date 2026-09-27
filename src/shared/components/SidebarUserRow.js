"use client";

import { useEffect, useState } from "react";
import { resolveUserRow } from "@/shared/utils/shell";
import ThemeToggle from "./ThemeToggle";
import Menu, { MenuItem } from "./Menu";
import LanguageSwitcher from "./LanguageSwitcher";
import IconButton from "./IconButton";

/**
 * Sidebar user row per the Signal board: avatar initial, name (SSO name when
 * present, else "Admin"), auth mode, theme toggle. A menu holds Language
 * (opens the LanguageSwitcher modal) and Logout (existing logout behavior).
 * The SSO name pill in the header is preserved separately.
 */
export default function SidebarUserRow() {
  const [status, setStatus] = useState({});
  const [languageOpen, setLanguageOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadAuthStatus() {
      try {
        const res = await fetch("/api/auth/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setStatus(data || {});
      } catch {
        if (!cancelled) setStatus({});
      }
    }
    loadAuthStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = async () => {
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (res.ok) window.location.assign("/login");
    } catch (err) {
      console.error("Failed to logout:", err);
    }
  };

  const { name, sub } = resolveUserRow(status);

  return (
    <>
      <div className="flex items-center gap-2.5 border-t border-line px-2 pt-3">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sky font-display text-sm font-bold text-bg"
          aria-hidden="true"
        >
          {name.charAt(0).toUpperCase()}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="truncate text-[13px] font-semibold text-text">{name}</p>
          <p className="truncate text-xs text-muted">{sub}</p>
        </div>
        <ThemeToggle className="size-11 rounded-[10px] border border-line bg-transparent hover:border-subtle" />
        <Menu
          trigger={<IconButton icon="more_vert" label="Account menu" className="size-11" />}
          align="end"
        >
          <MenuItem icon="translate" label="Language" onSelect={() => setLanguageOpen(true)} />
          <MenuItem icon="logout" label="Logout" danger onSelect={handleLogout} />
        </Menu>
      </div>
      <LanguageSwitcher hideTrigger isOpen={languageOpen} onClose={() => setLanguageOpen(false)} />
    </>
  );
}
