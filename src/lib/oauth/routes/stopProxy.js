import { NextResponse } from "next/server";
import {
  stopTraeProxy,
  stopWindsurfProxy,
  stopZedProxy,
  stopXaiProxy,
  stopCodexProxy,
  stopXiaomiMimoProxy,
  otherOwnerActive,
} from "@/lib/oauth/utils/server";
import { oauthScope } from "@/lib/oauth/scope";

// GET /api/oauth/[provider]/stop-proxy - stop the loopback callback server
export default async function stopProxy(provider, request) {
  const supported = ["trae", "windsurf", "zed", "xai", "codex", "xiaomi-mimo"].includes(provider);
  if (!supported) {
    return NextResponse.json(
      { error: "Proxy only supported for codex/xai/trae/windsurf/zed/xiaomi-mimo" },
      { status: 400 },
    );
  }

  // Another principal's live flow must not be killed by this caller.
  const scope = await oauthScope(request);
  if (scope instanceof Response) return scope;
  if (scope) {
    if (otherOwnerActive(provider, scope.ctx.userId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
