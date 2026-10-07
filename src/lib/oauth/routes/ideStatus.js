import { NextResponse } from "next/server";
import { detectIdeInstalled } from "@/lib/oauth/utils/ideDetect";
import { hostOnlyRefusal } from "@/lib/oauth/scope";

// GET /api/oauth/[provider]/ide-status - detect local IDE install (host FS probe)
export default async function ideStatus(provider, request) {
  const refused = await hostOnlyRefusal(request);
  if (refused) return refused;
  // Detect whether the IDE is installed locally (used by import-token UX).
  if (provider !== "trae" && provider !== "windsurf") {
    return NextResponse.json(
      { error: "ide-status only supported for trae/windsurf" },
      { status: 400 },
    );
  }
  const status = await detectIdeInstalled(provider);
  return NextResponse.json(status);
}
