"use client";

import PropTypes from "prop-types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Button from "@/shared/components/Button";
import Modal from "@/shared/components/Modal";
import Callout from "@/shared/components/Callout";
import { ACTIVE } from "@/shared/brand";
import { fetchIdentities } from "@/shared/utils/accountApi";
import { DATA_ACTIONS, consumeDataReauth, describeDiffEntry } from "./backupShared";

// Shown until the server reports the real path (and if that request fails).
const DEFAULT_DATABASE_FILE = `~/.${ACTIVE.dataDirName}/db/data.sqlite`;

/** Real SQLite path from the server, with a sensible placeholder meanwhile. */
export function useDatabaseFile() {
  const [databaseFile, setDatabaseFile] = useState(DEFAULT_DATABASE_FILE);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/environment", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.databaseFile) setDatabaseFile(data.databaseFile);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return databaseFile;
}

// Not a secret: which dialog started the provider round trip (and whether the
// owner had already chosen to replace differing users), so a failed return
// reopens the right dialog. The one-time proof itself is never stored.
const INTENT_KEY = "tokenhop.backupReauthIntent";

/** Remember the dialog that is leaving for the provider sign-in. */
export function rememberReauthIntent(intent) {
  try {
    sessionStorage.setItem(INTENT_KEY, JSON.stringify(intent));
  } catch {}
}

function takeReauthIntent() {
  try {
    const raw = sessionStorage.getItem(INTENT_KEY);
    sessionStorage.removeItem(INTENT_KEY);
    const intent = raw ? JSON.parse(raw) : null;
    return intent && DATA_ACTIONS.includes(intent.action) ? intent : null;
  } catch {
    return null;
  }
}

const FAILED_TEXT = "Single sign-on check failed. Nothing was changed. Verify again to continue.";

/** Drop the return markers but keep any other query and the `#data` anchor. */
function scrubReturnQuery() {
  const url = new URL(window.location.href);
  url.searchParams.delete("ssoReauth");
  url.searchParams.delete("workspace");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash || "#data"}`);
}

/** Linked SSO providers: `list` ("oidc"/"saml"), load `status`, and `retry`. */
export const providersShape = PropTypes.shape({
  list: PropTypes.arrayOf(PropTypes.string).isRequired,
  status: PropTypes.oneOf(["loading", "ready", "failed"]).isRequired,
  retry: PropTypes.func,
});
export const NO_PROVIDERS = { list: [], status: "ready", retry: () => {} };

/**
 * Fresh single sign-on for backups (YAN-1012).
 *
 * - `providers`: linked SSO providers (`providersShape`); an empty `list`
 *   hides the option, `status` tells loading/failed apart from "none linked".
 * - `returned`: the provider round trip result, consumed exactly once (the ref
 *   survives the dev StrictMode double effect): `{ action, workspaceId,
 *   ssoProof, error, force }`. The query is scrubbed before the one-shot GET;
 *   the proof lives only in React state, never in storage, URL or logs.
 */
export function useDataReauth() {
  const [linked, setLinked] = useState({ list: [], status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [returned, setReturned] = useState(null);
  const doneRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the load on retry.
  useEffect(() => {
    let cancelled = false;
    setLinked((s) => ({ ...s, status: "loading" }));
    fetchIdentities()
      .then((body) => {
        const have = new Set((body?.identities || []).map((i) => i?.provider));
        const list = ["oidc", "saml"].filter((p) => have.has(p));
        if (!cancelled) setLinked({ list, status: "ready" });
      })
      .catch(() => {
        if (!cancelled) setLinked({ list: [], status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get("ssoReauth");
    if (!flag || doneRef.current) return;
    doneRef.current = true;
    const intent = takeReauthIntent();
    scrubReturnQuery();
    // The stored intent only counts for the action that actually came back.
    const force = intent?.action === flag && Boolean(intent.force);
    if (!DATA_ACTIONS.includes(flag)) {
      // `failed`: never call the one-shot GET; reopen the dialog that started it.
      if (flag === "failed") {
        setReturned({
          action: intent?.action ?? null,
          workspaceId: intent?.workspaceId ?? null,
          ssoProof: null,
          error: FAILED_TEXT,
          force,
        });
      }
      return;
    }
    const workspaceId = flag.startsWith("workspace.") ? params.get("workspace") : null;
    const target = { action: flag, workspaceId };
    if (flag.startsWith("workspace.") && !workspaceId) {
      // Malformed return: no workspace to consume for, so report a failed check.
      setReturned({ ...target, ssoProof: null, error: FAILED_TEXT, force });
      return;
    }
    consumeDataReauth(target)
      .then((body) => {
        if (typeof body?.ssoProof !== "string" || !body.ssoProof) throw new Error("No proof.");
        setReturned({ ...target, ssoProof: body.ssoProof, error: "", force });
      })
      .catch(() => setReturned({ ...target, ssoProof: null, error: FAILED_TEXT, force }));
  }, []);

  const clearReturned = useCallback(() => setReturned(null), []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const providers = useMemo(() => ({ ...linked, retry }), [linked, retry]);
  return { providers, returned, clearReturned };
}

/** Open the dialog a provider round trip result belongs to (state setters in `to`). */
export function routeReturned(returned, to) {
  const { action, workspaceId, ssoProof, error, force } = returned;
  const result = { ssoProof: ssoProof || null, ssoOnly: true, error: error || "", force };
  if (action === "instance.export") to.setInstanceOpen(result);
  else if (action === "instance.import") to.setImportReauth(result);
  else if (action?.startsWith("workspace.")) {
    to.setWorkspaceOpen({ ...result, workspaceId, tab: action.slice("workspace.".length) });
  } else to.setStatus({ type: "err", message: error });
}

/**
 * Instance import after the provider round trip: the page reloaded, so the
 * picked file is gone. Ask for it again while the check is still fresh.
 * `onFile` resolves to an error message when the file can't be read; it is
 * shown here, not behind the modal.
 */
export function ChooseFileAgain({ title, verified, error, onFile, onClose }) {
  const fileRef = useRef(null);
  const [readError, setReadError] = useState("");
  const pick = async (event) => {
    const file = event.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    setReadError("");
    setReadError((await onFile(file)) || "");
  };
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="upload" onClick={() => fileRef.current?.click()}>
            Choose file
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {verified ? (
          <Callout variant="ok" icon="verified_user" title="Verified with single sign-on">
            Choose the backup file again to continue. The check expires in 5 minutes.
          </Callout>
        ) : (
          <Callout variant="err" title={error || FAILED_TEXT}>
            Choose the backup file again, then verify once more.
          </Callout>
        )}
        {readError && (
          <p className="text-[13px] text-err" role="alert">
            {readError}
          </p>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        aria-label="Instance backup file"
        accept="application/json,.json"
        onChange={pick}
        className="hidden"
      />
    </Modal>
  );
}

ChooseFileAgain.propTypes = {
  title: PropTypes.string.isRequired,
  verified: PropTypes.bool,
  error: PropTypes.string,
  onFile: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};

/** One list of users from an import mismatch diff. */
export function DiffList({ title, entries, variant }) {
  if (!entries.length) return null;
  return (
    <div className="rounded-xl border border-line p-3">
      <p className="text-sm font-semibold text-text">
        {title} ({entries.length})
      </p>
      <ul className="mt-1.5 max-h-36 space-y-1 overflow-y-auto text-[13px] text-muted">
        {entries.map((entry) => {
          const { label, detail } = describeDiffEntry(entry);
          return (
            <li
              key={typeof entry === "string" ? entry : entry.id || JSON.stringify(entry)}
              className="flex flex-wrap gap-x-2"
            >
              <span className="font-medium text-text">{label}</span>
              {detail && <span className={variant === "err" ? "text-err" : ""}>{detail}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

DiffList.propTypes = {
  title: PropTypes.string.isRequired,
  entries: PropTypes.array.isRequired,
  variant: PropTypes.string,
};
