// Manual combo ordering (drag-and-drop in the dashboard list). Additive:
// NULL sortOrder falls back to createdAt. Backfill assigns dense ranks in
// creation order so existing installs keep their current list order.
import { tableHasColumn } from "./helpers.js";

export default {
  version: 6,
  name: "combo-sort-order",
  up(db) {
    if (!tableHasColumn(db, "combos", "sortOrder")) {
      db.exec(`ALTER TABLE combos ADD COLUMN sortOrder INTEGER`);
    }
    db.exec(
      `UPDATE combos SET sortOrder = (
         SELECT COUNT(*) FROM combos o
         WHERE o.createdAt < combos.createdAt
            OR (o.createdAt = combos.createdAt AND o.id < combos.id)
       ) WHERE sortOrder IS NULL`,
    );
  },
};
