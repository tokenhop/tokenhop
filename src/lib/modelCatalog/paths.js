import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";
import { installCatalogSource, setCatalogFile } from "open-sse/providers/catalogOverride.js";

export const CATALOG_FILE = path.join(DATA_DIR, "model-catalog.json");
// Trimmed upstream catalog, read by the add-models skill (not by the router).
export const CATALOG_RAW_FILE = path.join(DATA_DIR, "model-catalog-raw.json");

/** Point open-sse at the synced catalog file and hand its reader to capabilities.js. */
export async function installCatalog() {
  setCatalogFile(CATALOG_FILE);
  await installCatalogSource();
}
