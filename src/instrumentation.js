export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { isStartupExcludedBuildPhase } = await import("@/lib/db/processLock.js");
    if (isStartupExcludedBuildPhase()) return;

    // YAN-363 final wiring: exclusive DATA_DIR writer lock -> adapter
    // open/migrate -> multi-user resolved once -> strict owner bootstrap when
    // enabled -> activateGatewayKeys (legacy+off: skipped, no master/backup;
    // already hashed: validates root + schema). Runs BEFORE timers, model
    // sync, initializeApp and any request handling. A rejection is sticky:
    // register() throws and this process must serve nothing. The permissive
    // ensureOwnerBootstrap() call that used to live here is superseded by the
    // strict path inside the coordinator; permissive request-path callers in
    // users/session.js are unchanged.
    const { ensureGatewayKeyStartup } = await import("@/lib/db/startupReadiness.js");
    await ensureGatewayKeyStartup();

    // YAN-351: a bad users & teams switch env value fails startup, not the first request.
    await import("@/lib/users/featureSwitch.js");

    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Custom-model capability toggles (YAN-657); refreshed again on every change.
    await import("@/lib/customModelCaps.js")
      .then((m) => m.refreshCustomModelCaps())
      .catch((err) => console.warn("[CustomModelCaps] initial load failed:", err?.message));

    // YAN-311: warm reliability overrides from the store for API-only servers
    // serving /v1 traffic (layout.js never mounts when no dashboard page is loaded).
    const { bootstrapReliabilityPolicy } = await import(
      "@/lib/reliability/initReliabilityPolicy.js"
    );
    await bootstrapReliabilityPolicy();
  }
}
