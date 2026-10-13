// In-memory workspace selection for multi-user CLI sessions (YAN-377). Pure
// state + API scoping, no UI: menu wiring belongs to the designer lane.
// Nothing selected (single-user, or never picked) leaves every request pristine.
const api = require("./client");

let choices = [];
let selectedId;

function setSelected(id) {
  selectedId = id || undefined;
  api.setSelectedWorkspace(selectedId);
}

const getSelectedWorkspaceId = () => selectedId;
const getWorkspaceChoices = () => choices;

/** Select a workspace from the known choices; false when the id is unknown. */
function selectWorkspace(id) {
  if (!choices.some((w) => w.id === id)) return false;
  setSelected(id);
  return true;
}

/**
 * GET /api/auth/status. Returns the status data only when multi-user is on,
 * remembering the principal's workspaces and defaulting to the Default one
 * (or keeping a still-valid earlier selection). Off/failed → null, no state.
 */
async function loadMultiUserState() {
  const res = await api.getAuthStatus();
  if (!res.success || res.data?.multiUserActive !== true) {
    choices = [];
    setSelected(undefined);
    return null;
  }
  choices = res.data.principal?.workspaces ?? [];
  if (!choices.some((w) => w.id === selectedId)) {
    setSelected((choices.find((w) => w.isDefault) ?? choices[0])?.id);
  }
  return res.data;
}

module.exports = {
  loadMultiUserState,
  selectWorkspace,
  getSelectedWorkspaceId,
  getWorkspaceChoices,
};
