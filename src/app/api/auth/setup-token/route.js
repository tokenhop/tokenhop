import { NextResponse } from "next/server";
import { requireMultiUser } from "@/lib/users/featureSwitch";
import { ensureOwnerBootstrap, mintSetupToken } from "@/lib/users/bootstrap";

// Mint a one-time owner SSO setup token (ADR-0003) for `tokenhop auth
// setup-token`. Local-only (dashboardGuard); replaces any unused token.
export async function POST() {
  const hidden = await requireMultiUser();
  if (hidden) return hidden;
  await ensureOwnerBootstrap();
  return NextResponse.json(await mintSetupToken(), { headers: { "Cache-Control": "no-store" } });
}
