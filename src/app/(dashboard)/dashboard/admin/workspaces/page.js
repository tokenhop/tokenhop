"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, EmptyState, LoadingState, PageTitle } from "@/shared/components";
import { TABLE_HEAD_CELL, TABLE_HEAD_ROW } from "@/shared/components/displayPrimitives";
import { listWorkspaces } from "@/shared/utils/adminApi";
import { AdminGuard } from "../components/AdminShared";
import { adminLoadState, formatWhen } from "../adminView";

/** Shared workspaces only; listing and access decisions belong to the server. */
export default function AdminWorkspacesPage() {
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadState, setLoadState] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadState(null);
    setError("");
    try {
      const body = await listWorkspaces();
      if (!Array.isArray(body.workspaces)) throw new Error("Invalid workspace list response.");
      setWorkspaces(body.workspaces);
    } catch (err) {
      setLoadState(adminLoadState(err?.status) ?? "error");
      setError(err.message || "Failed to load workspaces.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const manage = (workspace) => (
    <Button
      variant="ghost"
      href={`/dashboard/admin/workspaces/${encodeURIComponent(workspace.id)}`}
      aria-label={`Manage ${workspace.name}`}
    >
      Manage
    </Button>
  );

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex flex-col gap-2">
        <PageTitle>Workspaces</PageTitle>
        <p className="text-sm text-muted">
          Shared workspaces only. Manage members and invitations; personal workspaces stay private.
        </p>
      </div>
      <AdminGuard loadState={loadState} error={error} onRetry={load}>
        <Card padding="none">
          {loading ? (
            <LoadingState label="Loading workspaces" className="p-4" />
          ) : workspaces.length === 0 ? (
            <EmptyState
              icon="workspaces"
              title="No shared workspaces"
              body="Shared workspaces appear here when they exist on this instance."
            />
          ) : (
            <>
              <div className="hidden overflow-x-auto md:block custom-scrollbar">
                <table className="w-full min-w-[640px] text-sm" aria-label="Shared workspaces">
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      {["Workspace", "Members", "Created", "Actions"].map((label) => (
                        <th
                          key={label}
                          scope="col"
                          className={`${TABLE_HEAD_CELL} px-4 py-3 text-start`}
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {workspaces.map((workspace) => (
                      <tr
                        key={workspace.id}
                        className="border-b border-line last:border-0 hover:bg-raised/60"
                      >
                        <td className="px-4 py-3 font-medium text-text">{workspace.name}</td>
                        <td className="px-4 py-3 text-muted">{workspace.memberCount}</td>
                        <td className="px-4 py-3 text-muted">{formatWhen(workspace.createdAt)}</td>
                        <td className="px-4 py-3">{manage(workspace)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="divide-y divide-line md:hidden">
                {workspaces.map((workspace) => (
                  <li key={workspace.id} className="flex flex-col gap-2 p-4">
                    <h2 className="break-words font-medium text-text">{workspace.name}</h2>
                    <p className="text-sm text-muted">Members: {workspace.memberCount}</p>
                    <p className="text-xs text-muted">Created: {formatWhen(workspace.createdAt)}</p>
                    {manage(workspace)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </AdminGuard>
    </div>
  );
}
