"use client";

import PropTypes from "prop-types";
import { StatusPill } from "@/shared/components";

/**
 * Display name of a connection's creator. displayName only; no email fallback.
 * @param {unknown} name
 * @returns {string|null}
 */
export function creatorLabel(name) {
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/**
 * Creator badge for one connection row. Renders nothing without a known name,
 * so single-user lists (no createdByDisplayName field) never change.
 */
export default function OwnerBadge({ name }) {
  const label = creatorLabel(name);
  if (!label) return null;
  return (
    <StatusPill variant="neutral" size="sm" title={`Created by ${label}`}>
      <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
        person
      </span>
      <span className="sr-only">Created by </span>
      {label}
    </StatusPill>
  );
}

OwnerBadge.propTypes = {
  name: PropTypes.string,
};
