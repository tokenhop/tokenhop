"use client";

import PropTypes from "prop-types";
import StatusPill from "./StatusPill";

/**
 * Settings/section header card: coral-bg icon tile + display title + subtitle +
 * optional status pill, on a plain panel card.
 */
export default function SectionCard({ icon, title, subtitle, status, statusLabel, className }) {
  return (
    <div
      className={`flex items-center gap-4 rounded-2xl border border-line bg-panel p-5 shadow-card${className ? ` ${className}` : ""}`}
    >
      <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-coral-bg text-coral-ink">
        <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
          {icon}
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="font-display text-2xl font-bold text-text">{title}</h2>
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
      </div>
      {status && (
        <StatusPill variant={status} size="sm" dot>
          {statusLabel ?? status}
        </StatusPill>
      )}
    </div>
  );
}

SectionCard.propTypes = {
  icon: PropTypes.string.isRequired,
  title: PropTypes.node.isRequired,
  subtitle: PropTypes.node,
  status: PropTypes.string,
  statusLabel: PropTypes.string,
  className: PropTypes.string,
};
