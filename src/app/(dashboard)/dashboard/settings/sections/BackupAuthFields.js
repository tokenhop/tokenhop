"use client";

import PropTypes from "prop-types";
import { useState } from "react";
import Input from "@/shared/components/Input";
import Select from "@/shared/components/Select";
import Button from "@/shared/components/Button";
import Callout from "@/shared/components/Callout";
import { safeAuthorizeUrl, startDataReauth, startErrorText } from "./backupShared";
import { providersShape, rememberReauthIntent } from "./BackupReauth";

/**
 * `ssoProof` is a one-time single sign-on proof (dialog state only, never
 * stored). `ssoOnly` marks an attempt that already used single sign-on: from
 * then on only a fresh check is accepted, never a password fallback.
 */
export const blankAuth = {
  password: "",
  passphrase: "",
  confirm: "",
  ssoProof: null,
  ssoOnly: false,
};

/** Dialog auth state seeded with a proof handed back after the provider round trip. */
export const authWithProof = (ssoProof) =>
  ssoProof ? { ...blankAuth, ssoProof, ssoOnly: true } : blankAuth;

/** A failed attempt that used `ssoProof` spends it: ask for a fresh check, no password. */
export const spendProof = (s) => ({ ...s, ssoProof: null, ssoOnly: true, password: "" });

const PROVIDER_LABELS = { oidc: "OIDC", saml: "SAML" };

/**
 * "Verify with single sign-on": starts a fresh provider sign-in bound to this
 * exact backup action and leaves the page. Shown only for linked providers.
 */
function SsoVerify({ sso, again, importing, disabled }) {
  const list = sso.providers.list;
  const [provider, setProvider] = useState(list[0]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  const start = async () => {
    setStarting(true);
    setError("");
    try {
      const body = await startDataReauth({
        provider,
        action: sso.action,
        workspaceId: sso.workspaceId,
      });
      const url = safeAuthorizeUrl(body?.authorizeUrl);
      if (!url) throw new Error("The provider did not return a valid sign-in URL.");
      rememberReauthIntent({
        action: sso.action,
        workspaceId: sso.workspaceId ?? null,
        force: Boolean(sso.force),
      });
      window.location.assign(url);
    } catch (err) {
      setError(startErrorText(err));
      setStarting(false);
    }
  };

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <p className="text-[13px] text-muted">
        {again
          ? "This attempt used single sign-on, so a password is not accepted. Verify again with your provider."
          : "Signed in with single sign-on? Verify with your provider instead."}{" "}
        You come back to this dialog
        {importing ? " and need to choose the backup file again." : "."}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        {list.length > 1 && (
          <Select
            label="Provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            options={list.map((p) => ({ value: p, label: PROVIDER_LABELS[p] || p }))}
            placeholder={null}
            disabled={starting || disabled}
            className="min-w-32"
          />
        )}
        <Button
          type="button"
          variant="secondary"
          icon="verified_user"
          onClick={start}
          loading={starting}
          disabled={disabled || !sso.action}
        >
          Verify with single sign-on
        </Button>
      </div>
      {error && (
        <p className="text-[13px] text-err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

SsoVerify.propTypes = {
  sso: PropTypes.shape({
    providers: providersShape.isRequired,
    action: PropTypes.string,
    workspaceId: PropTypes.string,
    force: PropTypes.bool,
  }).isRequired,
  again: PropTypes.bool,
  importing: PropTypes.bool,
  disabled: PropTypes.bool,
};

/** No provider to offer after an SSO attempt: still loading, load failed, or none linked. */
function ProvidersUnavailable({ providers }) {
  if (providers?.status === "loading") {
    return (
      <p className="text-[13px] text-muted" role="status">
        Checking your sign-in providers…
      </p>
    );
  }
  if (providers?.status === "failed") {
    return (
      <div className="flex flex-wrap items-center gap-2" role="alert">
        <p className="text-[13px] text-err">Could not load your sign-in providers.</p>
        <Button type="button" variant="ghost" size="sm" icon="refresh" onClick={providers.retry}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <p className="text-[13px] text-err" role="alert">
      Single sign-on is not available for your account right now.
    </p>
  );
}

ProvidersUnavailable.propTypes = { providers: providersShape };

/** Who-are-you check: verified state, password, or a fresh single sign-on check. */
function IdentityCheck({ auth, setAuth, mode, sso, disabled }) {
  const importing = mode === "import" || mode === "workspaceImport";
  const canSso = Boolean(sso?.providers?.list?.length);
  if (auth.ssoProof) {
    return (
      <Callout variant="ok" icon="verified_user" title="Verified with single sign-on">
        Good for one {importing ? "import" : "download"} within 5 minutes.
      </Callout>
    );
  }
  if (auth.ssoOnly) {
    if (canSso) return <SsoVerify sso={sso} again importing={importing} disabled={disabled} />;
    return <ProvidersUnavailable providers={sso?.providers} />;
  }
  return (
    <>
      <Input
        label="Your password"
        type="password"
        autoComplete="current-password"
        required
        value={auth.password}
        onChange={(e) => setAuth((s) => ({ ...s, password: e.target.value }))}
        placeholder="Current password"
        hint={
          mode === "import"
            ? "Re-confirms it is really you before anything is replaced."
            : "Re-confirms it is really you."
        }
      />
      {canSso && <SsoVerify sso={sso} importing={importing} disabled={disabled} />}
    </>
  );
}

IdentityCheck.propTypes = {
  auth: PropTypes.object.isRequired,
  setAuth: PropTypes.func.isRequired,
  mode: PropTypes.string,
  sso: PropTypes.object,
  disabled: PropTypes.bool,
};

/** Shared identity check + passphrase fields for every dialog in the backup UI. */
export default function AuthFields({
  auth,
  setAuth,
  mode,
  requiredPassphrase = false,
  sso = null,
  disabled = false,
}) {
  const workspace = mode === "workspaceExport" || mode === "workspaceImport";
  const passphraseRequired = workspace || requiredPassphrase;
  const showConfirm = mode === "workspaceExport" || (mode === "export" && Boolean(auth.passphrase));
  return (
    <div className="space-y-4">
      <IdentityCheck auth={auth} setAuth={setAuth} mode={mode} sso={sso} disabled={disabled} />
      <Input
        label={passphraseRequired ? "Backup passphrase (required)" : "Backup passphrase (optional)"}
        type="password"
        autoComplete={
          mode?.includes("Import") || mode === "import" ? "current-password" : "new-password"
        }
        required={passphraseRequired}
        value={auth.passphrase}
        onChange={(e) => setAuth((s) => ({ ...s, passphrase: e.target.value }))}
        placeholder="Portable across instances"
        hint={
          passphraseRequired
            ? "Required. Use the passphrase chosen when this backup was created."
            : "With a passphrase, the file restores on a different instance. Without one, it only restores where the same master key already exists."
        }
      />
      {showConfirm && (
        <Input
          label="Repeat passphrase"
          type="password"
          autoComplete="new-password"
          value={auth.confirm}
          onChange={(e) => setAuth((s) => ({ ...s, confirm: e.target.value }))}
          placeholder="Repeat passphrase"
          error={auth.confirm && auth.passphrase !== auth.confirm ? "Entries do not match." : ""}
        />
      )}
    </div>
  );
}

AuthFields.propTypes = {
  auth: PropTypes.shape({
    password: PropTypes.string,
    passphrase: PropTypes.string,
    confirm: PropTypes.string,
    ssoProof: PropTypes.string,
    ssoOnly: PropTypes.bool,
  }).isRequired,
  setAuth: PropTypes.func.isRequired,
  mode: PropTypes.oneOf(["export", "import", "workspaceExport", "workspaceImport"]),
  requiredPassphrase: PropTypes.bool,
  /** Linked SSO providers and the action/workspace a fresh check is bound to. */
  sso: PropTypes.shape({
    providers: providersShape.isRequired,
    action: PropTypes.string,
    workspaceId: PropTypes.string,
    /** Owner already chose to replace differing users (kept across the trip). */
    force: PropTypes.bool,
  }),
  disabled: PropTypes.bool,
};
