"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
import Menu, { MenuItem } from "./Menu";
import { switchWorkspace } from "@/shared/utils/accountApi";

/**
 * Sidebar workspace switcher (YAN-371), rendered only while multi-user is
 * active. Switching re-mints the session server-side, then reloads so every
 * workspace-scoped view and the cached auth status start fresh.
 * @param {object} props
 * @param {object} props.view Active `accountView(status)`.
 */
export default function WorkspaceSwitcher({ view }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const current = view.activeWorkspace;

  const select = async (id) => {
    if (id === current?.id || pending) return;
    setPending(true);
    setError("");
    try {
      await switchWorkspace(id);
      window.location.reload();
    } catch (err) {
      setError(err.message || translate("Could not switch workspace."));
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <Menu
        align="start"
        className="w-[216px]"
        trigger={
          <button
            type="button"
            disabled={pending}
            aria-label={`Workspace: ${current?.name || "None"}. Switch workspace`}
            className="flex min-h-11 w-full items-center gap-2.5 rounded-[10px] border border-line bg-raised px-3 text-start hover:border-subtle focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-60"
          >
            <span className="material-symbols-outlined text-[18px] text-muted" aria-hidden="true">
              {current?.kind === "personal" ? "person" : "groups"}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[11px] text-muted">Workspace</span>
              <span className="truncate text-[13px] font-semibold text-text">
                {current?.name || "Choose a workspace"}
              </span>
            </span>
            <span className="material-symbols-outlined text-[18px] text-muted" aria-hidden="true">
              {pending ? "progress_activity" : "unfold_more"}
            </span>
          </button>
        }
      >
        {view.workspaces.map((w) => (
          <MenuItem
            key={w.id}
            icon={w.kind === "personal" ? "person" : "groups"}
            label={w.kind === "personal" ? `${w.name} (personal)` : w.name}
            selected={w.id === current?.id}
            onSelect={() => select(w.id)}
          />
        ))}
      </Menu>
      {error ? (
        <p role="alert" className="px-1 text-xs text-err">
          {error}
        </p>
      ) : null}
    </div>
  );
}

WorkspaceSwitcher.propTypes = {
  view: PropTypes.shape({
    activeWorkspace: PropTypes.object,
    workspaces: PropTypes.arrayOf(PropTypes.object).isRequired,
  }).isRequired,
};
