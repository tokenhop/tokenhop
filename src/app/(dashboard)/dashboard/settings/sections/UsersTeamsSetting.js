"use client";

import PropTypes from "prop-types";
import { useEffect, useState } from "react";
import SettingRow from "@/shared/components/SettingRow";
import Toggle from "@/shared/components/Toggle";
import Callout from "@/shared/components/Callout";
import { ConfirmDialog } from "@/shared/components/Modal";

const ENV_NAME = "TOKENHOP_MULTI_USER";

/**
 * PATCH the switch on its own: the server requires `multiUserEnabled` to be
 * the only key, so this never goes through the multi-key settings save.
 * @param {boolean} enabled
 * @returns {Promise<object>} The updated `multiUserSwitch` state.
 */
async function saveSwitch(enabled) {
  const res = await fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ multiUserEnabled: enabled }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.code === "MULTI_USER_ENV_LOCKED") {
      throw new Error(`This is set by ${ENV_NAME}. Change it there and restart tokenhop.`);
    }
    throw new Error(data.error || "Could not change users & teams. Try again.");
  }
  return data.multiUserSwitch ?? data;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** One explanatory line inside the dialog (inline elements: it renders in a <p>). */
function Line({ children, tone = "muted" }) {
  return (
    <span
      className={
        tone === "warn"
          ? "mt-3 block rounded-lg bg-warn-bg px-3 py-2 font-medium text-warn"
          : "mt-2 block first:mt-0"
      }
    >
      {children}
    </span>
  );
}

Line.propTypes = { children: PropTypes.node, tone: PropTypes.oneOf(["muted", "warn"]) };

function TurnOnMessage() {
  return (
    <>
      <Line>
        Your existing data moves into a <strong className="text-text">Default</strong> workspace
        that you own.
      </Line>
      <Line>
        API keys are then shown by prefix only. Copy any keys you still need before you continue.
      </Line>
      <Line>
        Back up the master key (<code className="font-mono text-[12px]">DATA_DIR/keys/master</code>{" "}
        or <code className="font-mono text-[12px]">TOKENHOP_MASTER_KEY</code>). If you lose it, your
        saved credentials can't be decrypted.
      </Line>
      <Line>The first time you turn this on, restart tokenhop to finish setting it up.</Line>
    </>
  );
}

function TurnOffMessage({ othersAffected, activeUsers, sharedWorkspaces }) {
  return (
    <>
      <Line>tokenhop goes back to single-user mode.</Line>
      <Line>
        Nothing is deleted. Users, workspaces and memberships are kept and come back when you turn
        users & teams on again.
      </Line>
      {othersAffected && (
        <Line tone="warn">
          Other users lose access while users & teams is off.{" "}
          <span className="font-normal">
            Right now: {plural(activeUsers, "active user", "active users")},{" "}
            {plural(sharedWorkspaces, "shared workspace", "shared workspaces")}.
          </span>
        </Line>
      )}
    </>
  );
}

TurnOffMessage.propTypes = {
  othersAffected: PropTypes.bool,
  activeUsers: PropTypes.number,
  sharedWorkspaces: PropTypes.number,
};

/**
 * "Users & teams" instance switch (YAN-1547). GET /api/settings only sends
 * `multiUserSwitch` to instance managers, so its absence hides the row.
 * Every change asks for confirmation; when the effective mode flips the page
 * reloads so navigation and the shell pick up the new mode.
 */
export default function UsersTeamsSetting({ settings, onSaved }) {
  const serverState = settings.multiUserSwitch;
  const [state, setState] = useState(serverState);
  const [target, setTarget] = useState(null);

  useEffect(() => {
    setState(serverState);
  }, [serverState]);

  if (!state || typeof state !== "object") return null;

  const { stored, effective, envLocked, envValue, pendingRestart } = state;
  const activeUsers = Number(state.activeUsers) || 0;
  const sharedWorkspaces = Number(state.sharedWorkspaces) || 0;
  const othersAffected = activeUsers > 1 || sharedWorkspaces > 0;
  // The toggle shows the stored choice; under an env lock the pill shows what the env forces.
  const checked = stored === true;
  const turningOn = target === true;

  const confirm = async () => {
    const next = await saveSwitch(target);
    if (Boolean(next.effective) !== Boolean(effective)) {
      window.location.reload();
      // Keep the dialog busy until the reload replaces the page.
      return new Promise(() => {});
    }
    setState(next);
    onSaved?.(next);
    setTarget(null);
    return undefined;
  };

  const description = envLocked ? (
    <>
      Set by <code className="font-mono">{ENV_NAME}</code> in .env — change it there and restart.
    </>
  ) : (
    "For households and small teams: each person gets their own account, workspaces, API keys and connections."
  );

  return (
    <>
      <SettingRow
        label="Users & teams"
        description={
          <>
            {description}
            {effective && (activeUsers > 0 || sharedWorkspaces > 0) && (
              <span className="mt-1 block text-[12px] text-subtle">
                {plural(activeUsers, "active user", "active users")} ·{" "}
                {plural(sharedWorkspaces, "shared workspace", "shared workspaces")}
              </span>
            )}
          </>
        }
        settingKey="multiUserEnabled"
        control={
          <div className="flex items-center gap-2">
            {envLocked && (
              <span className="rounded-full bg-raised px-2 py-0.5 font-mono text-[11px] text-muted">
                Set by {ENV_NAME}={envValue ?? (effective ? "on" : "off")}
              </span>
            )}
            <Toggle
              checked={checked}
              onChange={(next) => setTarget(next)}
              disabled={envLocked || target !== null}
              aria-label="Users & teams"
            />
          </div>
        }
      />
      {pendingRestart && !effective && (
        <div className="py-4">
          <Callout variant="warn" icon="restart_alt" title="Restart needed">
            Restart tokenhop to finish turning on users & teams. The first start backs up your data,
            hashes API keys and encrypts credentials.
          </Callout>
        </div>
      )}
      <ConfirmDialog
        isOpen={target !== null}
        onClose={() => setTarget(null)}
        onConfirm={confirm}
        title={turningOn ? "Turn on users & teams?" : "Turn off users & teams?"}
        message={
          turningOn ? (
            <TurnOnMessage />
          ) : (
            <TurnOffMessage
              othersAffected={othersAffected}
              activeUsers={activeUsers}
              sharedWorkspaces={sharedWorkspaces}
            />
          )
        }
        confirmText={turningOn ? "Turn on" : "Turn off"}
        variant={!turningOn && othersAffected ? "danger" : "default"}
      />
    </>
  );
}

UsersTeamsSetting.propTypes = {
  settings: PropTypes.object.isRequired,
  onSaved: PropTypes.func,
};
