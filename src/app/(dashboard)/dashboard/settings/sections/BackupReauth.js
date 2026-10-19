"use client";

import PropTypes from "prop-types";
import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * Fresh single sign-on for backups (YAN-1012).
 *
 * - `providers`: linked SSO providers ("oidc"/"saml"); empty hides the option.
 * - `returned`: the provider round trip result, consumed exactly once (the ref
 *   survives the dev StrictMode double effect): `{ action, workspaceId,
 *   ssoProof, error, force }`. The query is scrubbed before the one-shot GET;
 *   the proof lives only in React state, never in storage, URL or logs.
 */
export function useDataReauth() {
  const [providers, setProviders] = useState([]);
  const [returned, setReturned] = useState(null);
  const doneRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetchIdentities()
      .then((body) => {
        const linked = new Set((body?.identities || []).map((i) => i?.provider));
        if (!cancelled) setProviders(["oidc", "saml"].filter((p) => linked.has(p)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get("ssoReauth");
    if (!flag || doneRef.current) return;
    doneRef.current = true;
    const intent = takeReauthIntent();
    scrubReturnQuery();
    const force = Boolean(intent?.force);
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
    if (flag.startsWith("workspace.") && !workspaceId) return;
    const target = { action: flag, workspaceId };
    consumeDataReauth(target)
      .then((body) => {
        if (typeof body?.ssoProof !== "string" || !body.ssoProof) throw new Error("No proof.");
        setReturned({ ...target, ssoProof: body.ssoProof, error: "", force });
      })
      .catch(() => setReturned({ ...target, ssoProof: null, error: FAILED_TEXT, force }));
  }, []);

  const clearReturned = useCallback(() => setReturned(null), []);
  return { providers, returned, clearReturned };
}

/**
 * Instance import after the provider round trip: the page reloaded, so the
 * picked file is gone. Ask for it again while the check is still fresh.
 */
export function ChooseFileAgain({ title, verified, error, onFile, onClose }) {
  const fileRef = useRef(null);
  const pick = (event) => {
    const file = event.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (file) onFile(file);
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
