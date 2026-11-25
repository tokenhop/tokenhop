// Pure SVG geometry helper for 7-day quota utilization sparklines (YAN-422).
// Kept separate from the React component so Vitest can unit-test it directly.

export const SPARKLINE_VIEW_W = 100;
export const SPARKLINE_VIEW_H = 20;
const PAD_Y = 2;
const PLOT_H = SPARKLINE_VIEW_H - PAD_Y * 2;

function clampPct(value) {
  return Math.min(100, Math.max(0, value));
}

function roundCoord(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Compute SVG polyline/area coordinates and summary stats for a quota window's
 * 7d usage history (`usedPct` on a fixed 0..100 scale, proportional X by `ts`).
 * Returns null when fewer than 2 valid points exist.
 *
 * @param {Array<{ ts: number, usedPct: number }>|null|undefined} history
 * @returns {{ linePoints: string, areaPoints: string, minPct: number, maxPct: number, latestPct: number, count: number }|null}
 */
export function buildSparklineGeometry(history) {
  if (!Array.isArray(history) || history.length < 2) return null;

  const valid = [];
  for (const pt of history) {
    if (!pt || typeof pt !== "object") continue;
    const ts = Number(pt.ts);
    const used = Number(pt.usedPct);
    if (!Number.isFinite(ts) || !Number.isFinite(used)) continue;
    valid.push({ ts, usedPct: clampPct(used) });
  }
  if (valid.length < 2) return null;

  valid.sort((a, b) => a.ts - b.ts);
  const firstTs = valid[0].ts;
  const span = valid[valid.length - 1].ts - firstTs;

  let minPct = Infinity;
  let maxPct = -Infinity;
  const coords = valid.map((pt, idx) => {
    if (pt.usedPct < minPct) minPct = pt.usedPct;
    if (pt.usedPct > maxPct) maxPct = pt.usedPct;
    const ratioX = span > 0 ? (pt.ts - firstTs) / span : idx / (valid.length - 1);
    const x = roundCoord(ratioX * SPARKLINE_VIEW_W);
    const y = roundCoord(SPARKLINE_VIEW_H - PAD_Y - (pt.usedPct / 100) * PLOT_H);
    return { x, y };
  });

  const linePoints = coords.map((c) => `${c.x},${c.y}`).join(" ");
  const baseline = SPARKLINE_VIEW_H - PAD_Y;
  const areaPoints = `${coords[0].x},${baseline} ${linePoints} ${coords[coords.length - 1].x},${baseline}`;

  return {
    linePoints,
    areaPoints,
    minPct: Math.round(minPct),
    maxPct: Math.round(maxPct),
    latestPct: Math.round(valid[valid.length - 1].usedPct),
    count: valid.length,
  };
}
