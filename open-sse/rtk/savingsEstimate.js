import { isHeadroomPhantomSavings } from "./headroom.js";

/**
 * Build the persisted per-request savings payload from measured token-saver deltas.
 * Estimated only: RTK bytes/4, real (non-phantom) Headroom tokens, PXPIPE estimates.
 * Prompt-only injects (Caveman/Ponytail) have no measurable baseline delta and
 * are never counted. Returns null when nothing measurable was saved.
 */
export function buildSavingsEntry({
  rtkStats,
  headroomStats,
  headroomDiagnostics,
  pxpipeSummary,
} = {}) {
  const byMethod = {};
  let tokensSavedEst = 0;
  let tokensBeforeEst = 0;

  if (rtkStats && Array.isArray(rtkStats.hits) && rtkStats.hits.length > 0) {
    const bytesSaved = Math.max(0, (rtkStats.bytesBefore || 0) - (rtkStats.bytesAfter || 0));
    if (bytesSaved > 0) {
      const saved = Math.round(bytesSaved / 4);
      const before = Math.round((rtkStats.bytesBefore || 0) / 4);
      byMethod.rtk = { tokensSavedEst: saved, tokensBeforeEst: before, hits: rtkStats.hits.length };
      tokensSavedEst += saved;
      tokensBeforeEst += before;
    }
  }

  if (
    headroomStats?.tokens_saved > 0 &&
    !isHeadroomPhantomSavings(headroomStats, headroomDiagnostics)
  ) {
    const saved = Number(headroomStats.tokens_saved) || 0;
    const before = Number(headroomStats.tokens_before) || saved;
    byMethod.headroom = { tokensSavedEst: saved, tokensBeforeEst: before };
    tokensSavedEst += saved;
    tokensBeforeEst += before;
  }

  if (pxpipeSummary?.applied && pxpipeSummary.tokensSavedEst > 0) {
    const saved = Number(pxpipeSummary.tokensSavedEst) || 0;
    const before = Number(pxpipeSummary.tokensBeforeEst) || saved;
    byMethod.pxpipe = {
      tokensSavedEst: saved,
      tokensBeforeEst: before,
      imageCount: pxpipeSummary.imageCount || 0,
    };
    tokensSavedEst += saved;
    tokensBeforeEst += before;
  }

  if (Object.keys(byMethod).length === 0) return null;
  return { tokensSavedEst, tokensBeforeEst, byMethod };
}
