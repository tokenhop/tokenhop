"use client";

import PropTypes from "prop-types";
import { useEffect, useState } from "react";
import { Callout, Select } from "@/shared/components";

/** Scope controls; server remains authority over every returned row. */
export default function UsageFilters({ workspaceId, canViewWorkspace, filters, onChange }) {
  const [keys, setKeys] = useState([]);
  const [members, setMembers] = useState([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    setKeys([]);
    setMembers([]);
    setError("");
    const get = async (url) => {
      const res = await fetch(url, { cache: "no-store", signal: controller.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load usage filters.");
      return data;
    };
    Promise.all([
      get(`/api/keys?workspaceId=${encodeURIComponent(workspaceId)}`),
      canViewWorkspace
        ? get(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`)
        : Promise.resolve({ members: [] }),
    ])
      .then(([keyData, memberData]) => {
        if (controller.signal.aborted) return;
        setKeys(keyData.keys || []);
        setMembers(memberData.members || []);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [workspaceId, canViewWorkspace]);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {canViewWorkspace && (
          <Select
            label="Usage scope"
            placeholder={null}
            value={filters.view}
            onChange={(e) => onChange({ view: e.target.value, userId: "" })}
            options={[
              { value: "workspace", label: "Workspace" },
              { value: "me", label: "Me" },
            ]}
          />
        )}
        {canViewWorkspace && filters.view === "workspace" && (
          <Select
            label="Member"
            placeholder={null}
            value={filters.userId || ""}
            onChange={(e) => onChange({ userId: e.target.value })}
            options={[
              { value: "", label: "All members" },
              ...members.map((m) => ({ value: m.userId, label: m.displayName || m.userId })),
            ]}
          />
        )}
        <Select
          label="API key"
          placeholder={null}
          value={filters.apiKeyId || ""}
          onChange={(e) => onChange({ apiKeyId: e.target.value })}
          options={[
            { value: "", label: "All keys" },
            ...keys.map((k) => ({ value: k.id, label: k.name || k.prefix || k.id })),
          ]}
        />
      </div>
      {error && <Callout variant="err">{error}</Callout>}
    </div>
  );
}

UsageFilters.propTypes = {
  workspaceId: PropTypes.string,
  canViewWorkspace: PropTypes.bool,
  filters: PropTypes.shape({
    view: PropTypes.string,
    userId: PropTypes.string,
    apiKeyId: PropTypes.string,
  }).isRequired,
  onChange: PropTypes.func.isRequired,
};
