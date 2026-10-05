// Forced password-change latch (YAN-358). Additive: installs with existing
// users get 0, so current credentials keep working; null-hash owner bootstrap
// sets 1 (see usersRepo). IF NOT EXISTS + CHECK keeps reruns a no-op.
import { tableHasColumn } from "./helpers.js";

export default {
  version: 7,
  name: "user-password-change",
  up(db) {
    if (!tableHasColumn(db, "users", "mustChangePassword")) {
      db.exec(
        `ALTER TABLE users ADD COLUMN mustChangePassword INTEGER NOT NULL DEFAULT 0 CHECK (mustChangePassword IN (0, 1))`,
      );
    }
    // Legacy null-hash owners must receive a challenge that can validate.
    db.exec(
      `UPDATE users SET mustChangePassword = 1 WHERE instanceRole = 'owner' AND passwordHash IS NULL`,
    );
  },
};
