import fs from "node:fs";
import { NextResponse } from "next/server";
import { buildEnvironmentReadout } from "@/lib/settingsFlags";
import { shouldUseSecureCookie } from "@/lib/auth/dashboardSession";
import { DATA_DIR, ignoredLegacyDataDir, isLegacyDataDir } from "@/lib/dataDir";
import { DATA_FILE } from "@/lib/db/paths";

// COUNT(*)/MIN() over usageHistory and two stats per request add up on a big
// DB and the dashboard polls this route: serve the storage readout from a short cache.
const STORAGE_TTL_MS = 60_000;
let storageCache = { at: 0, value: null, pending: null };

async function storageReadout() {
  if (storageCache.value && Date.now() - storageCache.at < STORAGE_TTL_MS)
    return storageCache.value;
  storageCache.pending ??= (async () => {
    let history = { rows: null, capped: false, oldest: null };
    let ok = true;
    try {
      const { getUsageHistoryStatsUnscoped } = await import("@/lib/db/repos/usageRetentionRepo.js");
      history = await getUsageHistoryStatsUnscoped();
    } catch {
      ok = false; // a failed read is never cached
    }
    const value = {
      databaseSizeBytes: databaseSizeBytes(),
      // Exact up to a cap; `usageHistoryRowsCapped` means "at least this many".
      usageHistoryRows: history.rows,
      usageHistoryRowsCapped: history.capped,
      usageHistoryOldest: history.oldest,
    };
    if (ok) storageCache = { at: Date.now(), value, pending: null };
    return value;
  })().finally(() => {
    storageCache.pending = null;
  });
  return storageCache.pending;
}

// Main file + WAL (the sidecar can be the bulk of a busy DB); null if unreadable.
function databaseSizeBytes() {
  try {
    let total = fs.statSync(DATA_FILE).size;
    try {
      total += fs.statSync(`${DATA_FILE}-wal`).size;
    } catch {}
    return total;
  } catch {
    return null;
  }
}

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/settings/environment — auth-protected (dashboardGuard gates
 * /api/settings*), read-only allowlisted non-secret env readout plus the
 * effective secure-cookie state. Secrets are never returned: the allowlist in
 * `@/lib/settingsFlags` excludes them and the denylist wins on misconfig.
 */
export async function GET(request) {
  try {
    const storage = await storageReadout();
    return NextResponse.json(
      {
        values: buildEnvironmentReadout(),
        dataDir: DATA_DIR,
        databaseFile: DATA_FILE,
        ...storage,
        isLegacyDataDir: isLegacyDataDir(),
        ignoredLegacyDataDir: ignoredLegacyDataDir(),
        cookieSecure: shouldUseSecureCookie(request),
        cookieSecureSource:
          process.env.AUTH_COOKIE_SECURE === "true"
            ? "env"
            : request?.headers?.get?.("x-forwarded-proto") === "https"
              ? "proxy"
              : "off",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Failed to load environment" }, { status: 500 });
  }
}
