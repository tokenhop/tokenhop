import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { audit } from "@/lib/users/audit.js";

export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { success: false, message: "Not allowed in production" },
      { status: 403 },
    );
  }

  const secret = process.env.SHUTDOWN_SECRET;
  const authorization = headers().get("authorization");

  if (!secret || authorization !== `Bearer ${secret}`) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  // YAN-367: bearer-secret host op — no principal; audit then exit.
  await audit({}, "hostOps.shutdown", { type: "hostOp", id: "shutdown" }, {});

  const response = NextResponse.json({ success: true, message: "Shutting down..." });

  setTimeout(() => {
    process.exit(0);
  }, 500);

  return response;
}
