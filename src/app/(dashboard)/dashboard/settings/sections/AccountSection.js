"use client";

import { useCallback, useEffect, useState } from "react";
import SectionCard from "@/shared/components/SectionCard";
import SettingRow from "@/shared/components/SettingRow";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import Callout from "@/shared/components/Callout";
import EmptyState from "@/shared/components/EmptyState";
import { Skeleton } from "@/shared/components/Loading";
import { ConfirmDialog } from "@/shared/components/Modal";
import useAuthStatus from "@/shared/hooks/useAuthStatus";
import { accountView } from "@/shared/utils/account";
import { fetchIdentities, signOutEverywhere, unlinkIdentity } from "@/shared/utils/accountApi";

const PROVIDER_LABELS = { password: "Password", oidc: "OIDC", saml: "SAML" };

function formatDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString();
}

/** Linked sign-in identities: list, and unlink SSO ones (never the last way in). */
function IdentitiesList() {
  const [identities, setIdentities] = useState(null);
  const [error, setError] = useState("");
  const [target, setTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [unlinkError, setUnlinkError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setIdentities((await fetchIdentities()).identities || []);
    } catch (err) {
      setError(err.message || "Could not load linked sign-ins.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const confirmUnlink = async () => {
    setBusy(true);
    setUnlinkError("");
    try {
      await unlinkIdentity(target.id);
      setTarget(null);
      await load();
    } catch (err) {
      setUnlinkError(err.message || "Could not unlink this sign-in.");
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Callout variant="err" title="Could not load linked sign-ins">
        {error}{" "}
        <Button variant="ghost" size="sm" onClick={load}>
          Retry
        </Button>
      </Callout>
    );
  }
  if (!identities) return <Skeleton className="h-16" />;
  if (identities.length === 0) {
    return <EmptyState compact icon="link_off" title="No linked sign-ins" />;
  }

  return (
    <>
      <ul className="divide-y divide-line">
        {identities.map((identity) => (
          <li key={identity.id} className="flex flex-wrap items-center gap-3 py-3">
            <Badge variant="neutral" size="sm" icon="login">
              {PROVIDER_LABELS[identity.provider] || identity.provider}
            </Badge>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-text">
                {identity.emailAtLink || identity.issuer || "Linked account"}
              </p>
              <p className="text-xs text-muted">Last used: {formatDate(identity.lastLoginAt)}</p>
            </div>
            {identity.provider !== "password" &&
              (identity.unlinkable ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon="link_off"
                  onClick={() => setTarget(identity)}
                >
                  Unlink
                </Button>
              ) : (
                <span className="text-xs text-muted">Your only way to sign in</span>
              ))}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        isOpen={Boolean(target)}
        onClose={() => {
          setTarget(null);
          setUnlinkError("");
        }}
        onConfirm={confirmUnlink}
        title="Unlink this sign-in?"
        message="You won't be able to sign in with it any more. Your other browsers and devices will be signed out."
        confirmText="Unlink"
        cancelText="Cancel"
        variant="danger"
        loading={busy}
        error={unlinkError || undefined}
      />
    </>
  );
}

/**
 * My account (YAN-371): profile, password, linked sign-ins, sessions and an
 * API keys shortcut. Rendered only while multi-user is active.
 */
export default function AccountSection() {
  const view = accountView(useAuthStatus());
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const signOutAll = async () => {
    setBusy(true);
    setError("");
    try {
      await signOutEverywhere();
      window.location.assign("/login");
    } catch (err) {
      setError(err.message || "Could not sign out everywhere.");
      setBusy(false);
    }
  };

  if (!view.active) return <Skeleton className="h-40" />;

  return (
    <div id="account" className="scroll-mt-24 space-y-4">
      <SectionCard
        icon="person"
        title="My account"
        subtitle="Your profile, sign-ins and sessions."
      />

      <div className="rounded-2xl border border-line bg-panel p-5 shadow-card divide-y divide-line">
        <SettingRow label="Name" control={<span className="text-sm text-text">{view.name}</span>} />
        <SettingRow
          label="Email"
          control={<span className="text-sm text-text">{view.email || "Not set"}</span>}
        />
        <SettingRow
          label="Role"
          description="Your role on this instance. An admin can change it."
          control={<Badge variant="info">{view.roleLabel}</Badge>}
        />
        <SettingRow
          label="Password"
          description="Change the password you use to sign in."
          control={
            <Button variant="secondary" icon="key" href="/login?changePassword=1">
              Change password
            </Button>
          }
        />
        <SettingRow
          label="API keys"
          description="Create and manage your gateway keys."
          control={
            <Button variant="secondary" icon="vpn_key" href="/dashboard/endpoint">
              Open API keys
            </Button>
          }
        />
      </div>

      <div className="rounded-2xl border border-line bg-panel p-5 shadow-card">
        <p className="text-[15px] font-semibold text-text">Linked sign-ins</p>
        <p className="mt-0.5 mb-2 text-[13px] text-muted">
          Single sign-on accounts linked to you. You can't unlink your last way to sign in.
        </p>
        <IdentitiesList />
      </div>

      <div className="rounded-2xl border border-line bg-panel p-5 shadow-card divide-y divide-line">
        <SettingRow
          label="This session"
          description={`Signed in with ${view.loginMethod}. Sign out ends this browser only.`}
          control={
            <Badge variant="ok" dot>
              Active
            </Badge>
          }
        />
        <SettingRow
          label="Sign out everywhere"
          description="End every session on every browser and device, including this one."
          control={
            <Button variant="danger" icon="devices" onClick={() => setConfirmAll(true)}>
              Sign out everywhere
            </Button>
          }
        />
      </div>

      <ConfirmDialog
        isOpen={confirmAll}
        onClose={() => setConfirmAll(false)}
        onConfirm={signOutAll}
        title="Sign out everywhere?"
        message="This signs you out on every browser and device, including this one."
        confirmText="Sign out everywhere"
        cancelText="Cancel"
        variant="danger"
        loading={busy}
        error={error || undefined}
      />
    </div>
  );
}
