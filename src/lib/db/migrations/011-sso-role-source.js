// IdP role provenance (YAN-359). Nullable: NULL = manual/legacy, 'idp' = admin
// granted by an SSO group match. No backfill, so existing admins stay manual.
import { tableHasColumn } from "./helpers.js";

export default {
  version: 11,
  name: "sso-role-source",
  up(db) {
    if (!tableHasColumn(db, "users", "instanceRoleSource")) {
      db.exec(
        `ALTER TABLE users ADD COLUMN instanceRoleSource TEXT CHECK (instanceRoleSource IN ('idp'))`,
      );
    }
  },
};
