// Budget notice claims (YAN-1832). Additive: one row per budget and kind
// (soft | hard) holding the last window that notice was sent for, so a
// restart inside a window never repeats it. Deleted with its budget (FK).
// Frozen: literal DDL, kept identical to TABLES.budgetNotices in ../schema.js.
import { tableExists } from "./helpers.js";

export default {
  version: 23,
  name: "budget-notices",
  up(db) {
    if (!tableExists(db, "budgetNotices")) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS budgetNotices (budgetId TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('soft', 'hard')), windowStart TEXT NOT NULL, signature TEXT NOT NULL, notifiedAt TEXT NOT NULL, PRIMARY KEY (budgetId, kind))`,
      );
    }
  },
};
