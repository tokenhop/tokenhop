// Synchronous, keyset-paged snapshot writer. Serializes an export head (the
// object `exportGatewayKeySnapshot` builds) to an open fd as ONE compact JSON
// document with the exact key order of the in-memory object. Entries whose
// value is STREAMED_SECTION are replaced by `[` + live rows + `]`, read page by
// page (constant memory) and validated row by row.
//
// The whole write is synchronous (no await): nothing can interleave a write
// between the head build and the last section page, so the file is one
// consistent snapshot.
import fs from "node:fs";
import { SECTIONS } from "../helpers/instanceSnapshotSchema.js";
import {
  NOOP_SEEN,
  STREAMED_SECTION,
  validateSectionRow,
} from "../helpers/instanceSnapshotTables.js";
import { MAX_SNAPSHOT_ROW_BYTES } from "./limits.js";
import { forEachBoundedSectionPage } from "./pagedRows.js";

export const EXPORT_ROW_TOO_LARGE = "EXPORT_ROW_TOO_LARGE";

const FLUSH_CHARS = 1 << 20; // ~1 MiB buffer
const DEFAULT_PAGE = 500;
const PAGE_SIZES = { requestDetails: 200 };

function pageSizeFor(name) {
  return PAGE_SIZES[name] ?? DEFAULT_PAGE;
}

function rowTooLarge(section, maxRowBytes) {
  return Object.assign(
    new Error(
      `A ${section} row is larger than ${Math.floor(maxRowBytes / (1024 * 1024))} MiB and could not be imported again. Delete or trim it, then retry the export.`,
    ),
    { code: EXPORT_ROW_TOO_LARGE },
  );
}

// True when the UTF-8 size of `json` exceeds `max` (cheap for the common small row).
function exceedsBytes(json, max) {
  if (json.length > max) return true; // bytes >= chars
  if (json.length * 3 <= max) return false; // bytes <= 3 * chars
  return Buffer.byteLength(json, "utf8") > max;
}

/**
 * Write `head` to `fd` as compact JSON.
 * @param {object} db sync adapter
 * @param {object} head export head; `head.__refs` (non-enumerable) carries validation refs
 * @param {number} fd open, writable file descriptor
 * @param {{ onProgress?: (p: {phase: "export", section: string, rows: number}) => void, maxRowBytes?: number }} [opts]
 *   a serialized row above `maxRowBytes` throws EXPORT_ROW_TOO_LARGE (the importer would reject it)
 * @returns {{ bytes: number }}
 */
export function writeSnapshotFileSync(
  db,
  head,
  fd,
  { onProgress, maxRowBytes = MAX_SNAPSHOT_ROW_BYTES } = {},
) {
  const sectionByName = new Map(SECTIONS.map((s) => [s.name, s]));
  let buf = "";
  let bytes = 0;

  const flush = () => {
    if (!buf) return;
    const data = Buffer.from(buf, "utf8");
    buf = "";
    let off = 0;
    while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off, null);
    bytes += data.length;
  };
  const put = (text) => {
    buf += text;
    if (buf.length >= FLUSH_CHARS) flush();
  };

  put("{");
  let first = true;
  for (const key of Object.keys(head)) {
    const value = head[key];
    if (value === STREAMED_SECTION) {
      const section = sectionByName.get(key);
      if (!section) throw new Error(`Unknown streamed snapshot section "${key}"`);
      put(`${first ? "" : ","}${JSON.stringify(key)}:[`);
      first = false;
      let rowCount = 0;
      forEachBoundedSectionPage(db, section, pageSizeFor(key), (rows) => {
        for (const row of rows) {
          validateSectionRow(section, row, head.__refs, NOOP_SEEN);
          const json = JSON.stringify(row);
          if (exceedsBytes(json, maxRowBytes)) {
            throw rowTooLarge(key, maxRowBytes);
          }
          put(`${rowCount === 0 ? "" : ","}${json}`);
          rowCount++;
        }
        onProgress?.({ phase: "export", section: key, rows: rowCount });
      });
      put("]");
      continue;
    }
    const json = JSON.stringify(value);
    if (json === undefined) continue; // same as JSON.stringify(object): key omitted
    put(`${first ? "" : ","}${JSON.stringify(key)}:${json}`);
    first = false;
  }
  put("}");
  flush();
  return { bytes };
}
