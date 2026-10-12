"use client";

// YAN-373: admin user detail, action-first: approve pending, change role, disable/enable, a temporary
// password the user must change, delete with cascade, and owner transfer with
// the current password as proof (SSO owners continue through their provider).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  PageTitle,
  SectionCard,
  Select,
  SettingRow,
} from "@/shared/components";
import { ConfirmDialog } from "@/shared/components/Modal";
import { LoadingState } from "@/shared/components/StateViews";
import { refreshPendingUsers } from "@/shared/hooks/usePendingUsers";
import { AdminGuard, RolePill, StatusBadge, userName } from "../../components/AdminShared";
import {
  TempPasswordBanner,
  TempPasswordDialog,
  TransferDialog,
} from "../../components/UserDialogs";
import { formatWhen, userSummary } from "../../adminView";
import { safeAuthorizeUrl } from "../../workspaces/[id]/workspaceApi";
import {
  deleteUser,
  getUser,
  signOutUserEverywhere,
  startSsoOwnershipTransfer,
  transferOwnership,
  updateUser,
} from "@/shared/utils/adminApi";

const ROLE_OPTIONS = [
  { value: "user", label: "User" },
  { value: "admin", label: "Admin" },
  { value: "pending", label: "Pending approval" },
];

const IDENTITY_LABELS = { password: "Password", oidc: "OIDC", saml: "SAML" };

const OWNER_OPTIONS = [{ value: "owner", label: "Owner" }, ...ROLE_OPTIONS];

function Row({ label, description, control }) {
  return <SettingRow label={label} description={description} control={control} />;
}

export default function AdminUserDetailPage() {
  const { id } = useParams() || {};
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadState, setLoadState] = useState(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState("");
  const [dialog, setDialog] = useState(null); // temp | transfer | delete
  const [transferPassword, setTransferPassword] = useState("");
  const [provider, setProvider] = useState("oidc");
  const actionErrorId = "user-action-error";

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    setLoadState(null);
    try {
      setUser((await getUser(id)).user);
    } catch (err) {
      if (err?.status === 404) setLoadState("gone");
      else if (err?.status === 403) setLoadState("denied");
      else {
        setLoadState("error");
        setError(err?.message || "Failed to load this user.");
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the manual retry signal
  useEffect(() => {
    reload();
  }, [reload, tick]);

  const isOwner = user?.instanceRole === "owner";
  const isPending = user?.instanceRole === "pending";
  const isDisabled = user?.status === "disabled";

  const mutate = async (fn, label) => {
    setBusy(true);
    setError("");
    try {
      // PATCH echoes the bare row: keep identities and workspaceCount from the detail read.
      const next = await fn();
      setUser((prev) => ({ ...prev, ...next }));
      refreshPendingUsers();
      return true;
    } catch (err) {
      setError(err?.message || `Could not ${label}.`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onApprove = () =>
    mutate(() => updateUser(user.id, { instanceRole: "user" }).then((b) => b.user), "approve");
  const onRole = (instanceRole) =>
    mutate(() => updateUser(user.id, { instanceRole }).then((b) => b.user), "change the role");
  const onToggleStatus = () =>
    mutate(
      () => updateUser(user.id, { status: isDisabled ? "active" : "disabled" }).then((b) => b.user),
      "change the status",
    );
  const onSignOutAll = async () => {
    if (await mutate(() => signOutUserEverywhere(user.id).then(() => user), "sign this user out")) {
      setDialog(null);
    }
  };
  const onDelete = async () => {
    if (await mutate(() => deleteUser(user.id).then(() => user), "delete this user")) {
      window.location.assign("/dashboard/admin/users");
    }
  };

  const onTransfer = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const body = await transferOwnership(user.id, transferPassword);
      setUser((prev) => ({ ...prev, ...(body.user || body) }));
      setDialog(null);
      setTransferPassword("");
    } catch (err) {
      if (err?.code === "reauth_unsupported") {
        setError("This owner signs in with single sign-on — pick a provider below instead.");
      } else {
        setError(err?.message || "Could not transfer ownership.");
      }
    } finally {
      setBusy(false);
    }
  }, [user, transferPassword]);

  const onSsoTransfer = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const body = await startSsoOwnershipTransfer(user.id, provider);
      const url = safeAuthorizeUrl(body?.authorizeUrl);
      if (url) window.location.assign(url);
      else setError("The provider did not return a valid sign-in URL.");
    } catch (err) {
      setError(err?.message || "Could not start the transfer.");
    } finally {
      setBusy(false);
    }
  }, [user, provider]);

  const transferTarget = useMemo(() => userName(user), [user]);

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex flex-col gap-2">
        <Button
          variant="ghost"
          size="sm"
          icon="arrow_back"
          className="self-start"
          href="/dashboard/admin/users"
        >
          Users
        </Button>
        <PageTitle>{loading ? "User" : userSummary(user)}</PageTitle>
      </div>

      <AdminGuard
        loadState={loadState}
        error={error}
        onRetry={() => setTick((t) => t + 1)}
        gone={{
          icon: "person",
          title: "This user no longer exists",
          body: "The account may have been deleted.",
          action: (
            <Button variant="secondary" href="/dashboard/admin/users">
              Back to users
            </Button>
          ),
        }}
      >
        {loading || !user ? (
          loading ? (
            <LoadingState label="Loading user" lines={5} />
          ) : null
        ) : (
          <>
            {banner ? (
              <TempPasswordBanner password={banner} onDismiss={() => setBanner("")} />
            ) : null}
            {error ? (
              <p id={actionErrorId} role="alert" className="text-sm text-err">
                {error}
              </p>
            ) : null}
            <SectionCard
              icon="person"
              title={userName(user)}
              subtitle={user.email || user.username || user.id}
            />
            <Card>
              <Row
                label="Role"
                description="Pending accounts can't sign in or join anything until approved."
                control={
                  <div className="flex flex-wrap items-center gap-2">
                    <RolePill role={user.instanceRole} />
                    <Select
                      label="Change role"
                      value={user.instanceRole}
                      onChange={(e) => onRole(e.target.value)}
                      options={isOwner ? OWNER_OPTIONS : ROLE_OPTIONS}
                      disabled={busy || isOwner}
                      className="min-w-44"
                    />
                    {isPending ? (
                      <Button
                        variant="primary"
                        size="sm"
                        icon="check"
                        onClick={onApprove}
                        loading={busy}
                      >
                        Approve as user
                      </Button>
                    ) : null}
                  </div>
                }
              />
              <Row
                label="Status"
                description="Disabling ends every session and revokes their API keys immediately."
                control={
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={user.status} />
                    <Button
                      variant={isDisabled ? "secondary" : "danger"}
                      size="sm"
                      onClick={() => (isDisabled ? onToggleStatus() : setDialog("disable"))}
                      loading={busy}
                      disabled={isOwner}
                    >
                      {isDisabled ? "Enable" : "Disable"}
                    </Button>
                  </div>
                }
              />
              <Row
                label="Account"
                description={`Signed up ${formatWhen(user.createdAt)} · last sign-in ${formatWhen(user.lastLoginAt)}.`}
                control={
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Badge variant="neutral" icon="groups">
                      {`${user.workspaceCount ?? 0} workspace${user.workspaceCount === 1 ? "" : "s"}`}
                    </Badge>
                    {user.mustChangePassword ? (
                      <Badge variant="warn">Must change password</Badge>
                    ) : null}
                  </div>
                }
              />
              <Row
                label="Sign-in methods"
                description="Password and single sign-on identities linked to this account."
                control={
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {(user.identities || []).length === 0 ? (
                      <span className="text-sm text-muted">None linked</span>
                    ) : (
                      user.identities.map((identity) => (
                        <Badge key={identity.id} variant="neutral" icon="login">
                          {IDENTITY_LABELS[identity.provider] || identity.provider}
                        </Badge>
                      ))
                    )}
                  </div>
                }
              />
              <Row
                label="Sign out everywhere"
                description="Ends every browser session for this user. Their API keys keep working."
                control={
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="devices"
                    onClick={() => setDialog("signout")}
                    disabled={busy || isOwner}
                  >
                    Sign out everywhere
                  </Button>
                }
              />
              <Row
                label="Temporary password"
                description="Sets a password they must change at next sign-in."
                control={
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="key"
                    onClick={() => setDialog("temp")}
                    disabled={busy || isOwner}
                  >
                    Set temporary password
                  </Button>
                }
              />
              {isOwner ? null : (
                <Row
                  label="Transfer ownership"
                  description={`Makes ${transferTarget} the instance owner and you an admin. Only the current owner can do this, with a password or provider proof.`}
                  control={
                    <Button
                      variant="secondary"
                      size="sm"
                      icon="sync_alt"
                      onClick={() => setDialog("transfer")}
                      disabled={busy || isPending || isDisabled}
                    >
                      Transfer to this user
                    </Button>
                  }
                />
              )}
              <Row
                label="Delete user"
                description="Removes the account, memberships and API keys. Their personal workspace and its data are deleted too."
                control={
                  <Button
                    variant="danger"
                    size="sm"
                    icon="delete"
                    onClick={() => setDialog("delete")}
                    disabled={busy || isOwner}
                  >
                    Delete user
                  </Button>
                }
              />
            </Card>

            {dialog === "temp" ? (
              <TempPasswordDialog
                user={user}
                onClose={() => setDialog(null)}
                onDone={(pw) => {
                  setDialog(null);
                  setBanner(pw);
                }}
              />
            ) : null}
            {dialog === "disable" ? (
              <ConfirmDialog
                isOpen
                onClose={() => setDialog(null)}
                onConfirm={async () => {
                  if (await onToggleStatus()) setDialog(null);
                }}
                title={`Disable ${transferTarget}?`}
                message="This ends every session and revokes this user's API keys immediately. You can enable their account again later."
                confirmText="Disable user"
                variant="danger"
                loading={busy}
                error={error || undefined}
              />
            ) : null}
            {dialog === "signout" ? (
              <ConfirmDialog
                isOpen
                onClose={() => setDialog(null)}
                onConfirm={onSignOutAll}
                title={`Sign ${transferTarget} out everywhere?`}
                message="Every browser and device signs out the next time it talks to the server. Their API keys are not affected."
                confirmText="Sign out everywhere"
                variant="danger"
                loading={busy}
                error={error || undefined}
              />
            ) : null}
            {dialog === "delete" ? (
              <ConfirmDialog
                isOpen
                onClose={() => setDialog(null)}
                onConfirm={onDelete}
                title={`Delete ${transferTarget}?`}
                message="This removes the account, every membership and API key, and deletes their personal workspace and its data. Shared workspaces keep working."
                confirmText="Delete user"
                variant="danger"
                loading={busy}
                error={error || undefined}
              />
            ) : null}
            {dialog === "transfer" ? (
              <TransferDialog
                name={transferTarget}
                busy={busy}
                password={transferPassword}
                onPassword={setTransferPassword}
                provider={provider}
                onProvider={setProvider}
                error={error}
                onClose={() => {
                  setDialog(null);
                  setTransferPassword("");
                  setError("");
                }}
                onTransfer={onTransfer}
                onSso={onSsoTransfer}
              />
            ) : null}
          </>
        )}
      </AdminGuard>
    </div>
  );
}
