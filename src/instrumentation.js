export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // YAN-311: warm reliability overrides from the store for API-only servers
    // serving /v1 traffic (layout.js never mounts when no dashboard page is loaded).
    const { bootstrapReliabilityPolicy } = await import(
      "@/lib/reliability/initReliabilityPolicy.js"
    );
    await bootstrapReliabilityPolicy();
  }
}
