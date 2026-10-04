// Skip during Next.js build/prerender — bootstrap would download cloudflared, init DNS, etc.
const isBuildPhase =
  process.env.NEXT_PHASE === "phase-production-build" ||
  process.env.NEXT_PHASE === "phase-export" ||
  process.env.NEXT_PHASE === "phase-static";

// Server-only singleton: guard via global so HMR / re-imports don't double-init
if (typeof window === "undefined" && !isBuildPhase && !global.__appBootstrapped) {
  global.__appBootstrapped = true;
  // YAN-363: watchdog/auto-resume are background writers, so they wait for
  // gateway-key startup readiness. Never started -> fail closed (skipped, not
  // run). Readiness imports nothing from initializeApp, so no cycle; in the
  // Next lifecycle instrumentation register() runs before layout evaluation,
  // so the promise is already in flight whenever this module loads.
  import("@/lib/db/startupReadiness.js")
    .then((m) => m.whenGatewayKeyStartupReady())
    .then(() => import("./initializeApp.js"))
    .then((m) => m.default())
    .catch((e) => console.error("[Bootstrap] init failed:", e.message));
}
