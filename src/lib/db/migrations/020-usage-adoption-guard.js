// YAN-1553: an owner or retained Default id proves prior usage adoption,
// including an install upgraded after a user-less restore removed its owner.
// Frozen: literal marker key, independent of future runtime ownership helpers.
export default {
  version: 20,
  name: "usage-adoption-guard",
  up(db) {
    db.run(
      `INSERT INTO _meta(key, value)
       SELECT 'usageAdoptedAt', ? WHERE EXISTS (SELECT 1 FROM users WHERE instanceRole = 'owner')
       OR EXISTS (SELECT 1 FROM _meta WHERE key = 'defaultWorkspaceId')
       ON CONFLICT(key) DO NOTHING`,
      [new Date().toISOString()],
    );
  },
};
