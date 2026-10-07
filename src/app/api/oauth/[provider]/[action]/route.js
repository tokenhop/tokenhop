import { NextResponse } from "next/server";
import authorize from "@/lib/oauth/routes/authorize";
import startProxy from "@/lib/oauth/routes/startProxy";
import pollStatus from "@/lib/oauth/routes/pollStatus";
import stopProxy from "@/lib/oauth/routes/stopProxy";
import ideStatus from "@/lib/oauth/routes/ideStatus";
import deviceCode from "@/lib/oauth/routes/deviceCode";
import registerSession from "@/lib/oauth/routes/registerSession";
import exchange from "@/lib/oauth/routes/exchange";
import poll from "@/lib/oauth/routes/poll";
import manualCode from "@/lib/oauth/routes/manualCode";

export async function GET(request, { params }) {
  try {
    const resolvedParams = await params;
    const { provider, action } = resolvedParams;
    const { searchParams } = new URL(request.url);
    if (action === "authorize")
      return await authorize(provider, request, { searchParams, params: resolvedParams });
    if (action === "start-proxy")
      return await startProxy(provider, request, { searchParams, params: resolvedParams });
    if (action === "poll-status")
      return await pollStatus(provider, request, { searchParams, params: resolvedParams });
    if (action === "stop-proxy")
      return await stopProxy(provider, request, { searchParams, params: resolvedParams });
    if (action === "ide-status")
      return await ideStatus(provider, request, { searchParams, params: resolvedParams });
    if (action === "device-code")
      return await deviceCode(provider, request, { searchParams, params: resolvedParams });
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.log("OAuth GET error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  try {
    const resolvedParams = await params;
    const { provider, action } = resolvedParams;
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid or empty request body" }, { status: 400 });
    }
    const { searchParams } = new URL(request.url);
    if (action === "register-session")
      return await registerSession(provider, request, {
        searchParams,
        body,
        params: resolvedParams,
      });
    if (action === "exchange")
      return await exchange(provider, request, { searchParams, body, params: resolvedParams });
    if (action === "poll")
      return await poll(provider, request, { searchParams, body, params: resolvedParams });
    if (action === "manual-code")
      return await manualCode(provider, request, { searchParams, body, params: resolvedParams });
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.log("OAuth POST error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
