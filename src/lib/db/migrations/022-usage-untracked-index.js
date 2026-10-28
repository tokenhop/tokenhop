// YAN-1702. Partial indexes for the pruned-before-tracking probe
// (hasUntrackedRollupDays): only rows it can match are indexed, so the
// `requests > 0 AND lastUsedAt = ''` EXISTS check stays O(untracked) instead
// of scanning the full window. dateKey-first serves the unscoped view,
// workspaceId-first the workspace-scoped view; a workspace-leading index
// alone cannot serve the unscoped window (and vice versa) because the
// first column would be unconstrained.
// CREATE INDEX IF NOT EXISTS is idempotent per the registry contract.
export default {
  version: 22,
  name: "usage-untracked-index",
  up(db) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_ur_untracked ON usageRollup(dateKey) WHERE requests > 0 AND lastUsedAt = ''`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_ur_untracked_ws ON usageRollup(workspaceId, dateKey) WHERE requests > 0 AND lastUsedAt = ''`,
    );
  },
};
