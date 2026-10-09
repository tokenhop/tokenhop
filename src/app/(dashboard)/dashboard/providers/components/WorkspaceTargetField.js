import PropTypes from "prop-types";
import { Select } from "@/shared/components";

/**
 * Workspace picker shown only when more than one workspace is available.
 * Renders nothing when sharing options are unambiguous (single workspace).
 */
export default function WorkspaceTargetField({ value, onChange, workspaces }) {
  if (!workspaces || workspaces.length <= 1) {
    return null;
  }

  return (
    <Select
      label="Connect to workspace"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      options={workspaces.map((workspace) => ({
        value: workspace.id,
        label: workspace.name,
      }))}
    />
  );
}

WorkspaceTargetField.propTypes = {
  value: PropTypes.string,
  onChange: PropTypes.func.isRequired,
  workspaces: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string.isRequired,
    }),
  ),
};
