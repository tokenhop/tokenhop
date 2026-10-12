"use client";

import PropTypes from "prop-types";
import { Button, Input, Select } from "@/shared/components";
import { MAP_ROLE_OPTIONS } from "./policyDraft";

/** One mapping row: group name, target shared workspace, granted role. */
export function MappingRow({ row, workspaces, disabled, onChange, onRemove }) {
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-line bg-raised/40 p-3 md:flex-row md:items-start">
      <Input
        label="Group"
        placeholder="Group name from your IdP"
        value={row.group}
        disabled={disabled}
        onChange={(e) => onChange(row.id, { group: e.target.value })}
        className="md:flex-1"
      />
      <Select
        label="Workspace"
        placeholder="Select a workspace"
        options={workspaces}
        value={row.workspaceId}
        disabled={disabled}
        onChange={(e) => onChange(row.id, { workspaceId: e.target.value })}
        className="md:flex-1"
      />
      <Select
        label="Role"
        placeholder={null}
        options={MAP_ROLE_OPTIONS}
        value={row.role}
        disabled={disabled}
        onChange={(e) => onChange(row.id, { role: e.target.value })}
        className="md:w-40"
      />
      <Button
        variant="ghost"
        icon="delete"
        disabled={disabled}
        aria-label={`Remove mapping for ${row.group || row.workspaceId || "new group"}`}
        onClick={() => onRemove(row.id)}
        className="w-full md:mt-6 md:w-auto"
      >
        Remove
      </Button>
    </li>
  );
}

MappingRow.propTypes = {
  row: PropTypes.shape({
    id: PropTypes.string.isRequired,
    group: PropTypes.string.isRequired,
    workspaceId: PropTypes.string.isRequired,
    role: PropTypes.string.isRequired,
  }).isRequired,
  workspaces: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.string.isRequired,
      label: PropTypes.node.isRequired,
    }),
  ).isRequired,
  disabled: PropTypes.bool,
  onChange: PropTypes.func.isRequired,
  onRemove: PropTypes.func.isRequired,
};
