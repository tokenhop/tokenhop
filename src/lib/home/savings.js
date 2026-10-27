/**
 * Build per-request savings payload to record in usageHistory meta.
 * Estimated tokens only from measurable savers:
 * - RTK: bytes saved / 4
 * - Headroom: proxy tokens_saved if !isHeadroomPhantomSavings
 * - PXPIPE: estimated tokens from transform
 * Prompt-only techniques (Caveman, Ponytail) have no measurable baseline delta.
 */
export { buildSavingsEntry } from "../../../open-sse/rtk/savingsEstimate.js";
