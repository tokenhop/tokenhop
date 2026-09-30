import { renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/** Sort locale entries by key only (stable across value changes). */
export function sortByKey(data) {
  return Object.fromEntries(Object.entries(data).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Write pretty JSON via tmp + rename so a crash never leaves a half-written file. */
export function writeJsonAtomic(path, data) {
  const tmp = join(dirname(path), `.${randomUUID()}.json`);
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}
