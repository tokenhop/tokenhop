// Loads the capability toggles saved with custom models (Add Custom Model) into
// capabilities.js so routing and media stripping honour them (YAN-657).
// Called at server start and after every custom-model change.
import { setCustomCapsSource } from "open-sse/providers/capabilities.js";
import { getCustomModelsUnscoped } from "@/lib/localDb";
import { ALIAS_TO_ID, getProviderAlias } from "@/shared/constants/providers";

export async function refreshCustomModelCaps() {
  const map = new Map();
  for (const m of await getCustomModelsUnscoped()) {
    if (!m?.caps || !m.providerAlias || !m.id) continue;
    // Requests reach getCapabilitiesForModel with the provider id; compatible
    // nodes are stored under their id already. Key both forms to be safe.
    const keys = new Set([
      m.providerAlias,
      ALIAS_TO_ID[m.providerAlias],
      getProviderAlias(m.providerAlias),
    ]);
    for (const p of keys) if (p) map.set(`${p}|${m.id}`, m.caps);
  }
  setCustomCapsSource(map);
  return map.size;
}
