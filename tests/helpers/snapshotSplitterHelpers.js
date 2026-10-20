// Shared fixtures for the snapshot JSON splitter tests (YAN-1013).
import { expect } from "vitest";
import {
  createSnapshotSplitter,
  parseSnapshotValue,
  SNAPSHOT_JSON_INVALID,
} from "@/shared/utils/snapshotJsonSplitter.js";

export const enc = new TextEncoder();
export const SECTIONS = ["budgets", "usageHistory", "requestDetails"];

export function chunkBytes(bytes, size) {
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

// Runs the splitter and re-assembles a plain object like a consumer would.
export function split(input, { size = 64 * 1024, streamed = SECTIONS, keep, ...limits } = {}) {
  const bytes = typeof input === "string" ? enc.encode(input) : input;
  const out = {};
  const events = { values: [], elements: [], starts: [], ends: [] };
  const splitter = createSnapshotSplitter({
    streamedArrays: new Set(streamed),
    keepKey: keep ? (k) => keep.has(k) : undefined,
    onValue(k, b) {
      events.values.push(k);
      out[k] = parseSnapshotValue(b);
    },
    onElement(k, b) {
      events.elements.push(k);
      out[k].push(parseSnapshotValue(b));
    },
    onArrayStart(k) {
      events.starts.push(k);
      out[k] = [];
    },
    onArrayEnd(k) {
      events.ends.push(k);
    },
    ...limits,
  });
  for (const c of chunkBytes(bytes, size)) splitter.write(c);
  splitter.end();
  return { out, events };
}

export function expectInvalid(fn, reason) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err, "expected the splitter to throw").toBeTruthy();
  expect(err.code).toBe(SNAPSHOT_JSON_INVALID);
  if (reason) expect(err.reason).toBe(reason);
}

export const DOC = {
  formatVersion: 3,
  apiKeyStorage: "hashed",
  budgets: [
    { id: "b1", note: 'q"uo\\te' },
    { id: "b2", n: [1, { a: null }] },
  ],
  credentialEncryption: { version: 1, nested: { deep: [true, false, "x]}"] } },
  usageHistory: [],
  kv: { "weird}key": "v{al[", arr: [[], {}] },
  requestDetails: [{ id: 1, data: "x" }],
  trailing: 12.5e3,
};
