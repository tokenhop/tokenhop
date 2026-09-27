"use client";

import PropTypes from "prop-types";
import Link from "next/link";
import { APP_CONFIG } from "@/shared/constants/config";
import { useShellStatus } from "@/shared/hooks";
import { resolveVersionChip } from "@/shared/utils/shell";
import SidebarNav from "./SidebarNav";
import GatewayStatusCard from "./GatewayStatusCard";
import SidebarUserRow from "./SidebarUserRow";
import IconButton from "./IconButton";

/**
 * Signal sidebar per the board: 248px width, panel background, 1px line
 * border. Top to bottom:
 * - Logo: tilted coral "9" tile, "router" wordmark, mono version chip
 * - Gateway status card: pulsing lime dot, online state, port line
 * - Grouped nav with badges via useShellStatus
 * - User row with theme toggle, language modal and logout menu
 *
 * @param {object} props
 * @param {() => void} [props.onClose] Called on mobile navigation to close the drawer.
 * @param {boolean} [props.inDrawer=false] Adjusts container styling when rendered inside a Drawer.
 */
export default function Sidebar({ onClose, inDrawer = false }) {
  const { loading, gatewayOnline, port, startedAt, badges, providerAttention, enableTranslator } =
    useShellStatus();
  const chip = resolveVersionChip(APP_CONFIG.version);

  return (
    <aside
      className={
        inDrawer
          ? "flex h-full min-h-0 w-full flex-col gap-5 bg-panel px-4 pt-6 pb-4 text-text"
          : "flex h-full min-h-0 w-[248px] shrink-0 flex-col gap-5 border-e border-line bg-panel px-4 pt-6 pb-4 text-text"
      }
    >
      {/* Logo block */}
      <div className="flex items-center gap-2.5 px-2">
        <Link
          href="/dashboard"
          onClick={onClose}
          className="flex items-center gap-2.5 focus-visible:outline-none focus-visible:shadow-focus"
        >
          <span
            className="-rotate-[8deg] flex size-9 items-center justify-center rounded-[11px] bg-coral font-display text-[22px] font-extrabold text-on-coral shadow-card"
            aria-hidden="true"
          >
            9
          </span>
          <span className="font-display text-[22px] font-bold tracking-[-0.02em] text-text">
            router
          </span>
        </Link>
        {chip.label ? (
          <span
            className="ms-auto max-w-[7.5rem] truncate rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap text-muted"
            title={chip.full}
          >
            v{chip.label}
          </span>
        ) : null}
        {inDrawer && onClose ? (
          <IconButton icon="close" label="Close navigation" onClick={onClose} />
        ) : null}
      </div>

      {/* Gateway status card */}
      <GatewayStatusCard
        loading={loading}
        online={gatewayOnline}
        port={port}
        startedAt={startedAt}
      />

      {/* Grouped navigation */}
      <SidebarNav
        enableTranslator={enableTranslator}
        badges={badges}
        providerAttention={providerAttention}
        onNavigate={onClose}
      />

      {/* User row */}
      <SidebarUserRow />
    </aside>
  );
}

Sidebar.propTypes = {
  onClose: PropTypes.func,
  inDrawer: PropTypes.bool,
};
