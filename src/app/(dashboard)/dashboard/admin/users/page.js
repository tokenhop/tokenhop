"use client";

// YAN-373: admin users list. Server-side search and role/status filters over
// the paged API. No client authorization logic: hidden while the switch is
// off (route 404), 403 renders the no-access state.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Card,
  EmptyState,
  Input,
  LoadingState,
  PageTitle,
  SegmentedControl,
} from "@/shared/components";
import { TABLE_HEAD_CELL, TABLE_HEAD_ROW } from "@/shared/components/displayPrimitives";
// Not re-exported by the barrel: a barrel import is `undefined` (React #130).
import Pagination from "@/shared/components/Pagination";
import { listUsers } from "@/shared/utils/adminApi";
import { refreshPendingUsers } from "@/shared/hooks/usePendingUsers";
import { AdminGuard, RolePill, StatusBadge, userName } from "../components/AdminShared";
import { adminLoadState, formatWhen } from "../adminView";

const ROLE_FILTERS = [
  { value: "all", label: "All roles" },
  { value: "pending", label: "Pending" },
  { value: "user", label: "User" },
  { value: "admin", label: "Admin" },
  { value: "owner", label: "Owner" },
];

const STATUS_FILTERS = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "disabled", label: "Disabled" },
];

const ROW_LABEL = (u) => `Open ${userName(u)}`;

export default function AdminUsersPage() {
  const [role, setRole] = useState("all");
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [data, setData] = useState({ users: [], totalItems: 0 });
  const [loading, setLoading] = useState(true);
  const [loadState, setLoadState] = useState(null); // "hidden"|"denied"|"error"
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [applied, setApplied] = useState(() => ({ role: "all", status: "all", query: "" }));

  // Debounce the text search; role/status apply immediately.
  useEffect(() => {
    if (role === applied.role && status === applied.status && query === applied.query) return;
    const timer = setTimeout(
      () => {
        setPage(1);
        setApplied({ role, status, query });
      },
      query === applied.query ? 0 : 300,
    );
    return () => clearTimeout(timer);
  }, [role, status, query, applied]);

  // Stale responses never overwrite newer ones: only the latest request id
  // may apply data, error or loading.
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const mine = ++reqId.current;
    setLoading(true);
    setError("");
    setLoadState(null);
    try {
      const body = await listUsers({
        page,
        pageSize,
        search: applied.query.trim(),
        role: applied.role,
        status: applied.status,
      });
      if (reqId.current !== mine) return;
      setData({
        users: Array.isArray(body.users) ? body.users : [],
        totalItems: body.pagination?.totalItems ?? 0,
      });
      refreshPendingUsers();
    } catch (err) {
      if (reqId.current !== mine) return;
      setLoadState(adminLoadState(err?.status) ?? "error");
      setError(err?.message || "Failed to load users.");
    } finally {
      if (reqId.current === mine) setLoading(false);
    }
  }, [page, pageSize, applied]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the manual retry signal
  useEffect(() => {
    load();
  }, [load, tick]);

  const rows = data.users;
  const filtering =
    applied.role !== "all" || applied.status !== "all" || applied.query.trim() !== "";

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex flex-col gap-2">
        <PageTitle>Users</PageTitle>
        <p className="max-w-2xl text-sm text-muted">
          Every account on this instance: approve pending users, change roles, and disable accounts.
        </p>
      </div>

      <AdminGuard loadState={loadState} error={error} onRetry={() => setTick((t) => t + 1)}>
        <Card padding="none">
          <div className="flex flex-col gap-4 p-4 sm:flex-row sm:flex-wrap sm:items-end">
            <SegmentedControl
              size="sm"
              options={ROLE_FILTERS}
              value={role}
              onChange={setRole}
              aria-label="Filter by role"
            />
            <SegmentedControl
              size="sm"
              options={STATUS_FILTERS}
              value={status}
              onChange={setStatus}
              aria-label="Filter by status"
            />
            <Input
              label="Search users"
              placeholder="Name, username or email"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="sm:ms-auto sm:max-w-64"
            />
          </div>

          {loading ? (
            <LoadingState label="Loading users" lines={6} className="p-4" />
          ) : rows.length === 0 ? (
            <EmptyState
              icon="group"
              title={filtering ? "No users match" : "No users yet"}
              body={
                filtering
                  ? "Adjust the filters or clear the search."
                  : "Users appear here after they accept an invitation or sign in."
              }
              action={
                filtering ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="clear"
                    onClick={() => {
                      setRole("all");
                      setStatus("all");
                      setQuery("");
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden overflow-x-auto md:block custom-scrollbar">
                <table className="w-full min-w-[720px] text-sm" aria-label="Users">
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th scope="col" className={`${TABLE_HEAD_CELL} px-4 py-3 text-start`}>
                        User
                      </th>
                      <th scope="col" className={`${TABLE_HEAD_CELL} px-4 py-3 text-start`}>
                        Email
                      </th>
                      <th scope="col" className={`${TABLE_HEAD_CELL} px-4 py-3 text-start`}>
                        Role
                      </th>
                      <th scope="col" className={`${TABLE_HEAD_CELL} px-4 py-3 text-start`}>
                        Status
                      </th>
                      <th
                        scope="col"
                        className={`${TABLE_HEAD_CELL} hidden px-4 py-3 text-end lg:table-cell`}
                      >
                        Workspaces
                      </th>
                      <th
                        scope="col"
                        className={`${TABLE_HEAD_CELL} hidden px-4 py-3 text-start lg:table-cell`}
                      >
                        Last sign-in
                      </th>
                      <th scope="col" className={`${TABLE_HEAD_CELL} px-4 py-3 text-end`}>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((u) => (
                      <tr
                        key={u.id}
                        className="border-b border-line last:border-0 hover:bg-raised/60"
                      >
                        <td className="max-w-[220px] px-4 py-3">
                          <p className="truncate font-medium text-text">{userName(u)}</p>
                          {u.username && u.username !== u.displayName ? (
                            <p className="truncate font-mono text-xs text-muted">{u.username}</p>
                          ) : null}
                        </td>
                        <td
                          className="max-w-[220px] truncate px-4 py-3 text-muted"
                          title={u.email || ""}
                        >
                          {u.email || "—"}
                        </td>
                        <td className="px-4 py-3">
                          <RolePill role={u.instanceRole} />
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={u.status} />
                        </td>
                        <td className="hidden px-4 py-3 text-end font-mono text-muted lg:table-cell">
                          {u.workspaceCount ?? "—"}
                        </td>
                        <td className="hidden px-4 py-3 text-muted lg:table-cell">
                          {formatWhen(u.lastLoginAt)}
                        </td>
                        <td className="px-4 py-3 text-end">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={ROW_LABEL(u)}
                            href={`/dashboard/admin/users/${encodeURIComponent(u.id)}`}
                          >
                            Manage
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Mobile stacked cards */}
              <ul className="flex flex-col divide-y divide-line md:hidden">
                {rows.map((u) => (
                  <li key={u.id} className="flex flex-col gap-2 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text">{userName(u)}</p>
                        <p className="truncate text-xs text-muted">
                          {u.email || u.username || "—"}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <RolePill role={u.instanceRole} />
                        <StatusBadge status={u.status} />
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      fullWidth
                      className="justify-center"
                      aria-label={ROW_LABEL(u)}
                      href={`/dashboard/admin/users/${encodeURIComponent(u.id)}`}
                    >
                      Manage
                    </Button>
                  </li>
                ))}
              </ul>
              <Pagination
                className="px-4"
                currentPage={page}
                pageSize={pageSize}
                totalItems={data.totalItems}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
              />
            </>
          )}
        </Card>
      </AdminGuard>
    </div>
  );
}
