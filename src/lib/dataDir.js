// The resolver is shared with the MITM server and the CLI (src/shared/dataDir).
import dataDir from "../shared/dataDir/index.cjs";

export const { getDataDir, isLegacyDataDir, ignoredLegacyDataDir } = dataDir;

export const DATA_DIR = getDataDir();

// YAN-1106: PINS the resolution for the process. The database adapter opens
// DATA_FILE once at startup and the single-writer lock is taken on that same
// directory, so mid-process the resolved directory is effectively fixed, yet
// getDataDir() re-runs mkdirSync (or existsSync probes) on every call and the hot
// gateway path asks per request. getDataDirMemo() therefore returns the first
// successful result for as long as the inputs it was resolved from are unchanged.
// The memo is keyed by those inputs (DATA_DIR, HOME, USERPROFILE, APPDATA): a
// test or embedding that changes one gets a fresh resolution, and a failed
// resolution is never remembered. It does NOT watch the filesystem: removing the
// directory underneath a running instance is outside what it protects, as it is
// for the open database. Use getDataDir() when a fresh probe is wanted.
let memo = null;
const memoInputs = () =>
  [
    process.env.DATA_DIR ?? "",
    process.env.HOME ?? "",
    process.env.USERPROFILE ?? "",
    process.env.APPDATA ?? "",
  ].join("\0");

export function getDataDirMemo() {
  const inputs = memoInputs();
  if (memo?.inputs === inputs) return memo.dir;
  const dir = getDataDir();
  memo = { inputs, dir };
  return dir;
}
