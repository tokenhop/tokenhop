"use client";

import PropTypes from "prop-types";
import Link from "next/link";
import { Button } from "@/shared/components";

/** Back link, combo icon tile, kind label, mono name and the Delete action. */
export default function ComboHeader({ kindLabel, comboName, backHref, onDelete }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <Link
          href={backHref}
          className="inline-flex size-11 items-center justify-center rounded-lg text-muted hover:text-coral-ink focus-visible:shadow-focus focus-visible:outline-none"
          aria-label="Back"
        >
          <span className="material-symbols-outlined rtl:-scale-x-100" aria-hidden="true">
            arrow_back
          </span>
        </Link>
        <div className="flex size-10 items-center justify-center rounded-lg bg-coral-bg">
          <span className="material-symbols-outlined text-coral-ink" aria-hidden="true">
            layers
          </span>
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted">
            <span>{kindLabel}</span> · <span>Combo</span>
          </p>
          <h1 className="truncate font-mono text-lg font-semibold">{comboName}</h1>
        </div>
      </div>
      <Button variant="danger" icon="delete" onClick={onDelete}>
        Delete
      </Button>
    </div>
  );
}

ComboHeader.propTypes = {
  kindLabel: PropTypes.string.isRequired,
  comboName: PropTypes.string.isRequired,
  backHref: PropTypes.string.isRequired,
  onDelete: PropTypes.func.isRequired,
};
