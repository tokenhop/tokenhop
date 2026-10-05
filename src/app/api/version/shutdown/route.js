import { NextResponse } from "next/server";
import { killAppProcesses, stopLauncher } from "@/lib/appUpdater";
import { audit } from "@/lib/users/audit.js";

// Shutdown app to release file locks for manual update
export async function POST() {
  await audit({}, "hostOps.shutdown", { type: "hostOp", id: "version/shutdown" }, {});
  try {
    await killAppProcesses();
  } catch {
    /* best effort */
  }

  const response = NextResponse.json({
    success: true,
    message: "Shutting down for manual update...",
  });

  setTimeout(() => {
    try {
      stopLauncher();
    } catch {
      /* best effort */
    }
    process.exit(0);
  }, 500);

  return response;
}
