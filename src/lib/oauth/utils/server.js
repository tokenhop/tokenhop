import { LIVE_FLOW_MAX_AGE_MS } from "./server/shared.js";
import { codexLiveSessions } from "./server/codex.js";
import { xaiLiveSessions } from "./server/xai.js";
import { traeLiveSessions } from "./server/trae.js";
import { windsurfLiveSessions } from "./server/windsurf.js";
import { zedLiveSessions } from "./server/zed.js";
import { xiaomiMimoLiveSessions } from "./server/xiaomi-mimo.js";

export { createSessionConnection, startLocalServer, waitForCallback } from "./server/shared.js";
export {
  registerCodexSession,
  getCodexSessionStatus,
  clearCodexSession,
  startCodexProxy,
  stopCodexProxy,
} from "./server/codex.js";
export {
  registerXaiSession,
  getXaiSessionStatus,
  clearXaiSession,
  startXaiProxy,
  stopXaiProxy,
} from "./server/xai.js";
export {
  registerTraeSession,
  getTraeSessionStatus,
  clearTraeSession,
  startTraeProxy,
  stopTraeProxy,
} from "./server/trae.js";
export {
  registerWindsurfSession,
  getWindsurfSessionStatus,
  clearWindsurfSession,
  startWindsurfProxy,
  stopWindsurfProxy,
} from "./server/windsurf.js";
export {
  registerZedSession,
  getZedSessionStatus,
  clearZedSession,
  startZedProxy,
  stopZedProxy,
} from "./server/zed.js";
export {
  registerXiaomiMimoSession,
  getXiaomiMimoSessionStatus,
  clearXiaomiMimoSession,
  startXiaomiMimoProxy,
  stopXiaomiMimoProxy,
} from "./server/xiaomi-mimo.js";

/** Refuse proxy lifecycle changes if any live flow belongs to another user. */
export function otherOwnerActive(provider, userId) {
  let entries = [];
  if (provider === "codex") entries = codexLiveSessions();
  else if (provider === "xai") entries = xaiLiveSessions();
  else if (provider === "trae") entries = traeLiveSessions();
  else if (provider === "windsurf") entries = windsurfLiveSessions();
  else if (provider === "zed") entries = zedLiveSessions();
  else if (provider === "xiaomi-mimo") entries = xiaomiMimoLiveSessions();
  // Only pending flows younger than the binding TTL count: finished, failed or
  // abandoned sessions are never cleared on stop (poll-status still reads
  // them), so counting them would lock other users out indefinitely.
  // ponytail: fixed 30 min ceiling (pendingBinding TTL), not each proxy's own timeout.
  const cutoff = Date.now() - LIVE_FLOW_MAX_AGE_MS;
  return entries.some(
    (s) =>
      s?.binding &&
      s.binding.userId !== userId &&
      s.status === "pending" &&
      (s.createdAt ?? 0) > cutoff,
  );
}
