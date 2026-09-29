import { getAdapter } from "@/lib/db/driver.js";
import { parseJson, stringifyJson } from "@/lib/db/helpers/jsonCol.js";
import { SAVINGS_LIFETIME_KEY } from "@/lib/db/repos/usageRepo.js";
import { SAVINGS_MILESTONES } from "@/shared/constants/savingsMilestones.js";

/** Largest valid acknowledged milestone, or 0 for an older install. */
export function normalizeAckedMilestone(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

/** Highest crossed but not yet acknowledged lifetime savings milestone. */
export function pendingSavingsMilestone(total, acknowledged) {
  if (typeof total !== "number" || !Number.isFinite(total)) return null;
  const ack = normalizeAckedMilestone(acknowledged);
  return SAVINGS_MILESTONES.findLast((milestone) => total >= milestone && ack < milestone) ?? null;
}

/** Persist a milestone acknowledgement monotonically across clients. */
export async function acknowledgeSavingsMilestone(milestone) {
  if (!SAVINGS_MILESTONES.includes(milestone)) throw new RangeError("Invalid savings milestone");
  const db = await getAdapter();
  let acknowledgedMilestone;
  db.transaction(() => {
    const row = db.get("SELECT data FROM settings WHERE id = 1");
    const current = row ? parseJson(row.data, {}) : {};
    acknowledgedMilestone = Math.max(
      normalizeAckedMilestone(current.savingsMilestoneAck),
      milestone,
    );
    db.run(
      "INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
      [stringifyJson({ ...current, savingsMilestoneAck: acknowledgedMilestone })],
    );
  });
  return { acknowledgedMilestone };
}

/**
 * Claim a crossed-but-unacknowledged milestone for display (YAN-408): the
 * acknowledgment write happens first, atomically, inside one transaction that
 * re-reads lifetime savings and the acknowledged value. Returns the milestone
 * when THIS call is what acknowledged it (so exactly one client shows the
 * toast), and null when nothing is pending or another client already claimed
 * it. The ack can only rise: a downgrade is never persisted.
 *
 * @param {number} milestone A milestone from SAVINGS_MILESTONES.
 * @returns {Promise<number|null>}
 */
export async function claimSavingsMilestone(milestone) {
  if (!SAVINGS_MILESTONES.includes(milestone)) throw new RangeError("Invalid savings milestone");
  const db = await getAdapter();
  let claimed = null;
  db.transaction(() => {
    const lifetimeRow = db.get("SELECT value FROM _meta WHERE key = ?", [SAVINGS_LIFETIME_KEY]);
    const lifetime = lifetimeRow ? Number(lifetimeRow.value) || 0 : 0;
    const settingsRow = db.get("SELECT data FROM settings WHERE id = 1");
    const current = settingsRow ? parseJson(settingsRow.data, {}) : {};
    const ack = normalizeAckedMilestone(current.savingsMilestoneAck);
    if (pendingSavingsMilestone(lifetime, ack) !== milestone) return;
    db.run(
      "INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
      [stringifyJson({ ...current, savingsMilestoneAck: milestone })],
    );
    claimed = milestone;
  });
  return claimed;
}
