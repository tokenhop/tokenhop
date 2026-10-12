"use client";

import PropTypes from "prop-types";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Button, Card, LoadingState, PageTitle, StatTile } from "@/shared/components";
import { AdminGuard } from "../../components/AdminShared";
import { adminLoadState, formatWhen } from "../../adminView";
import DeleteWorkspaceDialog from "./DeleteWorkspaceDialog";
import InvitationsPanel from "./InvitationsPanel";
import MembersPanel from "./MembersPanel";
import { consumeWorkspaceReauth, getWorkspace } from "./workspaceApi";

/** Counts section: one StatTile per resource; legacy key storage can't be counted. */
function CountsCard({ detail }) {
  const { counts, encryption } = detail;
  const tiles = [
    ["Connections", counts.connections],
    ["Nodes", counts.nodes],
    ["Combos", counts.combos],
    ["API keys", counts.apiKeys === null ? "—" : counts.apiKeys],
    ["Invitations", counts.invitations],
    ["Budgets", counts.budgets],
    ["Grants out", counts.grantsOut],
    ["Members", detail.workspace.memberCount],
  ];
  // `grantBudgetsElsewhere`: budgets held in OTHER workspaces that this delete
  // also removes. `Budgets` above is this workspace only, so no double count.
  const elsewhere = counts.grantBudgetsElsewhere;
  return (
    <Card>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map(([label, value]) => (
          <StatTile key={label} eyebrow={label} value={value} />
        ))}
      </div>
      {counts.apiKeysLegacy ? (
        <p className="mt-3 text-xs text-muted">
          API keys use legacy storage, so their count is not available.
        </p>
      ) : null}
      {Number.isInteger(elsewhere) ? (
        <p className="mt-3 text-sm text-muted">
          {elsewhere > 0
            ? `Deleting this workspace also removes ${elsewhere} budget${elsewhere === 1 ? "" : "s"} held in other workspaces by its outgoing grants. They are not counted in Budgets above.`
            : "No budgets in other workspaces depend on this workspace's outgoing grants."}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-muted">
        {encryption.dekWrapped
          ? "This workspace has a wrapped encryption key (DEK) for its stored credentials. Deleting the workspace destroys the key, making the stored secrets unrecoverable."
          : "This workspace stores no encryption key of its own."}
      </p>
    </Card>
  );
}

CountsCard.propTypes = { detail: PropTypes.object.isRequired };

/** Danger zone row. The Default workspace can never be deleted (server 409s). */
function DangerZone({ detail, onDeleteClick }) {
  const isDefault = detail.workspace.isDefault;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-lg font-bold text-text">Delete workspace</h2>
          <p className="text-sm text-muted">
            {isDefault
              ? "The Default workspace cannot be deleted."
              : "Permanently remove this workspace, its credentials and its memberships."}
          </p>
        </div>
        <Button
          variant="danger"
          icon="delete"
          disabled={isDefault}
          onClick={onDeleteClick}
          aria-label={`Delete ${detail.workspace.name}`}
        >
          Delete
        </Button>
      </div>
    </Card>
  );
}

DangerZone.propTypes = {
  detail: PropTypes.object.isRequired,
  onDeleteClick: PropTypes.func.isRequired,
};

/**
 * Workspace detail (YAN-373): header, counts, members, invitations and a
 * guarded delete. The server owns every allow/deny decision; a 403/404 from
 * any call swaps the page to the server's verdict. An `?ssoReauth=1` return
 * from the IdP consumes the one-time proof exactly once (StrictMode-guarded)
 * and reopens the delete dialog — name and checkbox must be re-entered.
 */
export default function AdminWorkspaceDetailPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading workspace" lines={5} />}>
      <WorkspaceDetail />
    </Suspense>
  );
}

function WorkspaceDetail() {
  const { id } = useParams() || {};
  const searchParams = useSearchParams();
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadState, setLoadState] = useState(null);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [ssoProof, setSsoProof] = useState(null);
  const [reauthFailed, setReauthFailed] = useState(false);
  const reauthDoneRef = useRef(false);

  const onTerminal = useCallback(
    (err) => setLoadState(err?.status === 404 ? "gone" : adminLoadState(err?.status)),
    [],
  );

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadState(null);
    setError("");
    try {
      setDetail(await getWorkspace(id));
    } catch (err) {
      if (err?.status === 404) setLoadState("gone");
      else if (err?.status === 403) setLoadState("denied");
      else {
        setLoadState("error");
        setError(err.message || "Failed to load this workspace.");
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // IdP return: consume the one-time proof once (ref survives the dev
  // StrictMode double effect), then scrub the query with the history API so
  // the router keeps no state to restore. The proof itself lives only in
  // component state; it is never written to storage or logs.
  useEffect(() => {
    const flag = searchParams?.get("ssoReauth");
    if (!id || (flag !== "1" && flag !== "failed") || reauthDoneRef.current) return;
    reauthDoneRef.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    // Failed round trip: show the error, never call the one-shot GET.
    if (flag === "failed") {
      setReauthFailed(true);
      setDialogOpen(true);
      return;
    }
    consumeWorkspaceReauth(id)
      .then((body) => {
        if (typeof body?.ssoProof !== "string") throw new Error("No proof returned.");
        setSsoProof(body.ssoProof);
        setDialogOpen(true);
      })
      .catch((err) => {
        if (err?.status === 403) setLoadState("denied");
        else {
          setReauthFailed(true);
          setDialogOpen(true);
        }
      });
  }, [id, searchParams]);

  const onDeleted = useCallback(() => {
    window.location.assign("/dashboard/admin/workspaces");
  }, []);

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex flex-col gap-2">
        <Button
          variant="ghost"
          size="sm"
          icon="arrow_back"
          className="self-start"
          href="/dashboard/admin/workspaces"
        >
          Workspaces
        </Button>
        <PageTitle>{loading || !detail ? "Workspace" : detail.workspace.name}</PageTitle>
        {detail ? (
          <p className="text-sm text-muted">
            Shared workspace · created {formatWhen(detail.workspace.createdAt)} · updated{" "}
            {formatWhen(detail.workspace.updatedAt)}
            {detail.workspace.isDefault ? " · Default workspace" : ""}
          </p>
        ) : null}
      </div>
      <AdminGuard
        loadState={loadState}
        error={error}
        onRetry={load}
        gone={{
          icon: "groups",
          title: "This workspace no longer exists",
          body: "It may have been deleted.",
          action: (
            <Button variant="secondary" href="/dashboard/admin/workspaces">
              Back to workspaces
            </Button>
          ),
        }}
      >
        {id ? (
          loading || !detail ? (
            <LoadingState label="Loading workspace" lines={5} />
          ) : (
            <>
              <CountsCard detail={detail} />
              <MembersPanel workspaceId={id} onTerminal={onTerminal} />
              <InvitationsPanel workspaceId={id} onTerminal={onTerminal} />
              <DangerZone detail={detail} onDeleteClick={() => setDialogOpen(true)} />
            </>
          )
        ) : null}
      </AdminGuard>
      {dialogOpen && detail ? (
        <DeleteWorkspaceDialog
          workspace={detail.workspace}
          ssoProof={ssoProof}
          grantBudgetsElsewhere={detail.counts.grantBudgetsElsewhere ?? null}
          requireSso={reauthFailed}
          initialError={
            reauthFailed
              ? "Single sign-on re-authentication failed. Nothing was deleted — re-authenticate with your provider for a fresh proof."
              : ""
          }
          onClose={() => {
            setDialogOpen(false);
            setSsoProof(null);
            setReauthFailed(false);
          }}
          onProofSpent={() => setSsoProof(null)}
          onDeleted={onDeleted}
        />
      ) : null}
    </div>
  );
}
