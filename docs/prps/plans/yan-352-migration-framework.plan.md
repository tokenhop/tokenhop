# YAN-352 — migration framework for non-additive schema changes

Target: v1.1.0 (trunk `master`, no backport). Trunk landing: anytime, inert (no
user-visible change, no switch needed).

## Design

1. **Frozen baseline** `migrations/001-initial.js`: literal v1.0.0 DDL (identical
   to `TABLES` at `v1.0.0`, `git diff v1.0.0 -- src/lib/db/schema.js` is empty).
   Never imports `TABLES`. Fresh DBs run 001→latest.
2. **Helpers** `migrations/helpers.js`: `tableExists`, `tableHasColumn`,
   `indexExists`, `rebuildTable(db, name, newDef, copySql?)`, `backfill(db, sql, params)`.
3. **Runner** (`migrate.js`): each migration runs with `PRAGMA foreign_keys=OFF`
   (set outside the transaction — SQLite forbids it inside), then
   `PRAGMA foreign_key_check` before commit, FKs back ON in `finally`. Prevents
   `DROP TABLE` cascades during rebuilds (SQLite 12-step procedure).
4. **Backup gate**: any pending migration on a DB that already has tables.
   Drops `SCHEMA_VERSION` / `backupSchemaVersion`.
5. **sql.js backup**: `ATTACH` writes into the in-memory FS, so export bytes,
   drop `requestDetails` in a scratch DB, write the file.
6. **Export/import**: `exportDb()` adds `schemaVersion`; `importDb()` rejects a
   non-integer or newer `schemaVersion`; missing = legacy export, accepted.
7. **Drift guard test**: chain-only shape (no additive sync) == `TABLES`.

## Tasks

| #   | File                                        | Change                                |
| --- | ------------------------------------------- | ------------------------------------- |
| 1   | `src/lib/db/migrations/001-initial.js`      | frozen DDL                            |
| 2   | `src/lib/db/migrations/helpers.js`          | new helpers                           |
| 3   | `src/lib/db/migrations/index.js`            | pattern doc                           |
| 4   | `src/lib/db/migrate.js`                     | FK toggle, backup gate, export runner |
| 5   | `src/lib/db/backup.js`                      | sql.js path                           |
| 6   | `src/lib/db/schema.js`                      | drop SCHEMA_VERSION, header doc       |
| 7   | `src/lib/db/index.js`                       | export/import schemaVersion           |
| 8   | `tests/fixtures/db/v1.0.0.sql`              | legacy fixture                        |
| 9   | `tests/unit/db-migration-framework.test.js` | per-adapter tests                     |
| 10  | `docs/ARCHITECTURE.md`                      | one-line update                       |

## Validation

`npm run lint`, `npm test` (switch off + on), `npm run build`, `npm run lint:brand`.
