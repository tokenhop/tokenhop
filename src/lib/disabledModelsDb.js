// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
// YAN-364: new *Unscoped names; legacy names alias to the Unscoped twins.
export {
  getDisabledModelsUnscoped,
  getDisabledModelsUnscoped as getDisabledModels,
  getDisabledByProviderUnscoped,
  getDisabledByProviderUnscoped as getDisabledByProvider,
  disableModelsUnscoped,
  disableModelsUnscoped as disableModels,
  enableModelsUnscoped,
  enableModelsUnscoped as enableModels,
} from "@/lib/db/index.js";
