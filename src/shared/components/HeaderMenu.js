"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import PropTypes from "prop-types";
import { APP_CONFIG } from "@/shared/constants/appConfig";
import { ACTIVE } from "@/shared/brand";
import { useTheme } from "@/shared/hooks/useTheme";
import { resolveVersionChip } from "@/shared/utils/shell";
import { ConfirmDialog } from "./Modal";
import Menu, { MenuItem } from "./Menu";
import IconButton from "./IconButton";

// Lazy shell dialogs: the chunks load on first open, not with the shell.
// The `*Mounted` latches keep each modal mounted across close so the shared
// Modal still returns focus and handles Esc.
const ChangelogModal = dynamic(() => import("./ChangelogModal"), { ssr: false });
const LanguageSwitcher = dynamic(() => import("./LanguageSwitcher"), { ssr: false });

/**
 * Header app menus, switched by CSS breakpoint (no JS media query, so server
 * and client markup always match):
 * - from `sm` up: the grid menu (Change log, Theme, Shutdown, Logout)
 * - below `sm`: a ⋮ menu that also holds Support and Language, which the
 *   header hides inline at that width
 * Both use the shared Menu pattern (roving focus, typeahead, Esc close). The
 * Change log entry shows the full version.
 *
 * @param {object} props
 * @param {() => void} props.onLogout
 * @param {() => void} props.onDonate Opens the support dialog (owned by Header).
 */
export default function HeaderMenu({ onLogout, onDonate }) {
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [changelogMounted, setChangelogMounted] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [languageMounted, setLanguageMounted] = useState(false);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const { toggleTheme, isDark } = useTheme();
  const { full } = resolveVersionChip(APP_CONFIG.version, APP_CONFIG.build);

  const handleShutdown = async () => {
    setIsShuttingDown(true);
    try {
      await fetch("/api/version/shutdown", { method: "POST" });
    } catch {
      // Expected: the server is shutting down, so the fetch fails.
    }
    setIsShuttingDown(false);
    setShutdownOpen(false);
  };

  const openChangelog = () => {
    setChangelogMounted(true);
    setChangelogOpen(true);
  };
  const openLanguage = () => {
    setLanguageMounted(true);
    setLanguageOpen(true);
  };
  const changelogItem = (keyPrefix) => (
    <MenuItem
      key={`${keyPrefix}-changelog`}
      icon="history"
      label="Change log"
      trailing={full ? <span data-i18n-skip="true">{full}</span> : undefined}
      onSelect={openChangelog}
    />
  );
  const themeItem = (keyPrefix) => (
    <MenuItem
      key={`${keyPrefix}-theme`}
      icon={isDark ? "light_mode" : "dark_mode"}
      label="Theme"
      onSelect={() => toggleTheme()}
    />
  );
  const shutdownItem = (keyPrefix) => (
    <MenuItem
      key={`${keyPrefix}-shutdown`}
      icon="power_settings_new"
      label="Shutdown"
      danger
      onSelect={() => setShutdownOpen(true)}
    />
  );
  const logoutItem = (keyPrefix) => (
    <MenuItem
      key={`${keyPrefix}-logout`}
      icon="logout"
      label="Logout"
      danger
      onSelect={() => onLogout()}
    />
  );

  return (
    <>
      <span className="hidden sm:inline-flex">
        <Menu
          trigger={
            <IconButton
              icon="grid_view"
              label="Menu"
              className="border-transparent bg-transparent hover:bg-raised"
            />
          }
          align="end"
        >
          {changelogItem("desktop")}
          {themeItem("desktop")}
          {shutdownItem("desktop")}
          {logoutItem("desktop")}
        </Menu>
      </span>
      <span className="inline-flex sm:hidden">
        <Menu
          trigger={
            <IconButton
              icon="more_vert"
              label="Menu"
              className="border-transparent bg-transparent hover:bg-raised"
            />
          }
          align="end"
        >
          <MenuItem
            key="mobile-support"
            icon="volunteer_activism"
            label={`Support ${ACTIVE.slug}`}
            onSelect={onDonate}
          />
          <MenuItem
            key="mobile-language"
            icon="translate"
            label="Language"
            onSelect={openLanguage}
          />
          {themeItem("mobile")}
          {changelogItem("mobile")}
          {shutdownItem("mobile")}
          {logoutItem("mobile")}
        </Menu>
      </span>

      {changelogMounted && (
        <ChangelogModal isOpen={changelogOpen} onClose={() => setChangelogOpen(false)} />
      )}
      {languageMounted && (
        <LanguageSwitcher
          hideTrigger
          isOpen={languageOpen}
          onClose={() => setLanguageOpen(false)}
        />
      )}
      <ConfirmDialog
        isOpen={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdown}
        title="Close proxy"
        message="Are you sure you want to close the proxy server?"
        confirmText="Close"
        cancelText="Cancel"
        variant="danger"
        loading={isShuttingDown}
      />
    </>
  );
}

HeaderMenu.propTypes = {
  onLogout: PropTypes.func.isRequired,
  onDonate: PropTypes.func.isRequired,
};
