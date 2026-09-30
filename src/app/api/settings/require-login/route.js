import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";

// Public (no session): expose only what the login flow needs. Tunnel/Tailscale
// URLs and other settings stay behind the authenticated /api/settings.
export async function GET() {
  try {
    const settings = await getSettings();
    return NextResponse.json({ requireLogin: settings.requireLogin !== false });
  } catch {
    return NextResponse.json({ requireLogin: true }, { status: 200 });
  }
}
