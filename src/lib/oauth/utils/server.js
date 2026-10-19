import { LIVE_FLOW_MAX_AGE_MS, isLiveSession } from "./server/shared.js";
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
  releaseCodexListener,
  clearCodexSessionsFor,
  handleCodexCallback,
} from "./server/codex.js";
export {
  registerXaiSession,
  getXaiSessionStatus,
  clearXaiSession,
  startXaiProxy,
  stopXaiProxy,
  releaseXaiListener,
  clearXaiSessionsFor,
  handleXaiCallback,
} from "./server/xai.js";
export {
  registerTraeSession,
  getTraeSessionStatus,
  clearTraeSession,
  startTraeProxy,
  stopTraeProxy,
  releaseTraeListener,
  clearTraeSessionsFor,
} from "./server/trae.js";
export {
  registerWindsurfSession,
  getWindsurfSessionStatus,
  clearWindsurfSession,
  startWindsurfProxy,
  stopWindsurfProxy,
  releaseWindsurfListener,
  clearWindsurfSessionsFor,
} from "./server/windsurf.js";
export {
  registerZedSession,
  getZedSessionStatus,
  clearZedSession,
  startZedProxy,
  stopZedProxy,
  releaseZedListener,
  clearZedSessionsFor,
} from "./server/zed.js";
export {
  registerXiaomiMimoSession,
  getXiaomiMimoSessionStatus,
  clearXiaomiMimoSession,
  startXiaomiMimoProxy,
  stopXiaomiMimoProxy,
} from "./server/xiaomi-mimo.js";

/** True when any live flow on this provider's shared listener belongs to another user. */
export function otherOwnerActive(provider, userId) {
  let entries = [];
  if (provider === "codex") entries = codexLiveSessions();
  else if (provider === "xai") entries = xaiLiveSessions();
  else if (provider === "trae") entries = traeLiveSessions();
  else if (provider === "windsurf") entries = windsurfLiveSessions();
  else if (provider === "zed") entries = zedLiveSessions();
  else if (provider === "xiaomi-mimo") entries = xiaomiMimoLiveSessions();
  // Only in-flight (pending/exchanging) flows younger than the binding TTL count:
  // finished, failed or abandoned sessions are never cleared on stop (poll-status
  // still reads them), so counting them would lock other users out indefinitely.
  // ponytail: fixed 30 min ceiling (pendingBinding TTL), not each proxy's own timeout.
  const cutoff = Date.now() - LIVE_FLOW_MAX_AGE_MS;
  // An unbound live session (started before the switch flipped) belongs to no
  // caller here, so it keeps the listener up too.
  return entries.some(
    (s) => s && (!s.binding || s.binding.userId !== userId) && isLiveSession(s, cutoff),
  );
}
