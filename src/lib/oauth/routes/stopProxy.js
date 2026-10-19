import { NextResponse } from "next/server";
import {
  stopTraeProxy,
  stopWindsurfProxy,
  stopZedProxy,
  stopXaiProxy,
  stopCodexProxy,
  stopXiaomiMimoProxy,
  clearTraeSessionsFor,
  clearWindsurfSessionsFor,
  clearZedSessionsFor,
  clearXaiSessionsFor,
  clearCodexSessionsFor,
  otherOwnerActive,
} from "@/lib/oauth/utils/server";
import { oauthScope } from "@/lib/oauth/scope";

// Resolved lazily so partial module mocks (xiaomi-mimo tests) stay valid.
const clearOwn = (provider, userId) => {
  if (provider === "trae") clearTraeSessionsFor(userId);
  else if (provider === "windsurf") clearWindsurfSessionsFor(userId);
  else if (provider === "zed") clearZedSessionsFor(userId);
  else if (provider === "xai") clearXaiSessionsFor(userId);
  else if (provider === "codex") clearCodexSessionsFor(userId);
};

// GET /api/oauth/[provider]/stop-proxy - stop the loopback callback server
export default async function stopProxy(provider, request) {
  const supported = ["trae", "windsurf", "zed", "xai", "codex", "xiaomi-mimo"].includes(provider);
  if (!supported) {
    return NextResponse.json(
      { error: "Proxy only supported for codex/xai/trae/windsurf/zed/xiaomi-mimo" },
      { status: 400 },
    );
  }

  // YAN-739: the listener is shared. A caller only ever drops its OWN pending
  // flows; if another principal's live flow still needs the listener it stays
  // up (200, not an error: the caller did nothing wrong).
  const scope = await oauthScope(request);
  if (scope instanceof Response) return scope;
  if (scope) {
    clearOwn(provider, scope.ctx.userId);
    if (otherOwnerActive(provider, scope.ctx.userId)) {
      return NextResponse.json({ success: true, listenerKept: true });
    }
  }

  if (provider === "trae") stopTraeProxy();
  else if (provider === "windsurf") stopWindsurfProxy();
  else if (provider === "zed") stopZedProxy();
  else if (provider === "xai") stopXaiProxy();
  else if (provider === "codex") stopCodexProxy();
  else stopXiaomiMimoProxy();
  return NextResponse.json({ success: true });
}
