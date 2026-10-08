"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Popover from "./Popover";
import Badge from "./Badge";
import Button from "./Button";
import { ConfirmDialog } from "./Modal";
import { initialsOf } from "@/shared/utils/account";
import { signOut, signOutEverywhere } from "@/shared/utils/accountApi";

/**
 * Header account menu (YAN-371), rendered only while multi-user is active.
 * A Popover (role="dialog") holds the identity block plus actions; a
 * role="menu" may only contain menuitems. Avatar-only trigger below `sm`.
 * @param {object} props
 * @param {object} props.view Active `accountView(status)`.
 */
export default function AccountMenu({ view }) {
  const [open, setOpen] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      window.location.assign("/login");
    } catch (err) {
      setError(err.message || "Could not sign out. Try again.");
      setBusy(false);
    }
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        placement="bottom"
        aria-label="Account"
        className="w-72"
        trigger={
          <button
            type="button"
            className="flex min-h-11 items-center gap-2 rounded-full border border-line bg-raised ps-1 pe-1 text-start hover:border-subtle focus-visible:outline-none focus-visible:shadow-focus sm:pe-3"
            aria-label={`Account: ${view.name}`}
          >
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sky font-display text-xs font-bold text-bg"
              aria-hidden="true"
            >
              {initialsOf(view.name)}
            </span>
            <span className="hidden max-w-[140px] truncate text-xs font-medium text-text sm:inline">
              {view.name}
            </span>
          </button>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-text">{view.name}</p>
            {view.email ? <p className="truncate text-xs text-muted">{view.email}</p> : null}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge variant="info" size="sm">
                {view.roleLabel}
              </Badge>
              <Badge variant="neutral" size="sm" icon="login">
                {view.loginMethod}
              </Badge>
            </div>
          </div>
          <div className="flex flex-col gap-1 border-t border-line pt-3">
            <Button
              variant="ghost"
              icon="manage_accounts"
              fullWidth
              className="justify-start"
              onClick={() => {
                setOpen(false);
                window.location.assign("/dashboard/settings#account");
              }}
            >
              My account
            </Button>
            <Button
              variant="ghost"
              icon="devices"
              fullWidth
              className="justify-start"
              onClick={() => {
                setOpen(false);
                setConfirmAll(true);
              }}
            >
              Sign out everywhere
            </Button>
            <Button
              variant="ghost"
              icon="logout"
              fullWidth
              className="justify-start text-err"
              disabled={busy}
              onClick={() => run(signOut)}
            >
              Sign out
            </Button>
          </div>
          {error && !confirmAll ? (
            <p role="alert" className="text-xs text-err">
              {error}
            </p>
          ) : null}
        </div>
      </Popover>
      <ConfirmDialog
        isOpen={confirmAll}
        onClose={() => setConfirmAll(false)}
        onConfirm={() => run(signOutEverywhere)}
        title="Sign out everywhere?"
        message="This signs you out on every browser and device, including this one."
        confirmText="Sign out everywhere"
        cancelText="Cancel"
        variant="danger"
        loading={busy}
        error={confirmAll ? error : undefined}
      />
    </>
  );
}

AccountMenu.propTypes = {
  view: PropTypes.shape({
    name: PropTypes.string.isRequired,
    email: PropTypes.string,
    roleLabel: PropTypes.string.isRequired,
    loginMethod: PropTypes.string.isRequired,
  }).isRequired,
};
