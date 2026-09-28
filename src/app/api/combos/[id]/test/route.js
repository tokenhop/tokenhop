import { NextResponse } from "next/server";
import { getComboById } from "@/lib/localDb";
import {
  runComboProbe,
  checkProbeRateLimit,
  PROBE_RATE_LIMIT_MS,
  PROBE_TIMEOUT_MS,
} from "@/sse/services/comboProbe.js";

export const dynamic = "force-dynamic";

// POST /api/combos/[id]/test - Dry-run probe through the real combo pipeline.
// Auth: same dashboard guard as every /api/combos/* route (proxy-level).
// Rate limit: 1 probe per combo per 10s. Timeout: 60s server-side.
export async function POST(_request, { params }) {
  try {
    const { id } = await params;
    if (typeof id !== "string" || id.length === 0 || id.length > 128) {
      return NextResponse.json({ error: "Invalid combo id" }, { status: 400 });
    }

    const combo = await getComboById(id);
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    const { allowed, retryAfterMs } = checkProbeRateLimit(id);
    if (!allowed) {
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);
      return NextResponse.json(
        {
          error: `Probe rate limited: try again in ${retryAfterSec}s (1 per ${PROBE_RATE_LIMIT_MS / 1000}s per combo)`,
          retryAfterMs,
        },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
      );
    }

    // Timeout returns 504 to the client; the probe itself is not aborted
    // (no signal threads into executors), so it may finish in the background.
    // Timer is cleared on settle so it never holds the event loop.
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Probe timed out after ${PROBE_TIMEOUT_MS / 1000}s`);
        error.status = 504;
        reject(error);
      }, PROBE_TIMEOUT_MS);
    });
    const result = await Promise.race([runComboProbe({ comboId: id }), timeout]).finally(() =>
      clearTimeout(timer),
    );

    return NextResponse.json({
      comboId: id,
      comboName: result.comboName,
      strategy: result.strategy,
      attempts: result.attempts,
      served: result.served,
      totalMs: result.totalMs,
      summary: result.summary,
      ranAt: new Date().toISOString(),
    });
  } catch (error) {
    const status =
      Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
        ? error.status
        : 500;
    console.log("Error running combo probe:", error?.message || error);
    return NextResponse.json(
      { error: status === 500 ? "Probe failed" : error.message },
      { status },
    );
  }
}
