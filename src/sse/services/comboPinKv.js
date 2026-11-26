// App-side persistence for combo conversation pins (YAN-2468), so a gateway
// restart does not route a running conversation as a new one. Installed once at
// startup from src/instrumentation.js, after DB readiness; never an import side effect.
import { makeKv } from "@/lib/db/helpers/kvStore.js";
import { restoreComboPins, setComboPinPersistence } from "open-sse/services/cacheAffinity.js";

export const COMBO_PIN_KV_SCOPE = "comboPins";

/**
 * Mirror combo pins to the kv table and load the ones still live. Pins hold ids
 * only (workspace / combo name / hashed conversation key → member), never secrets.
 * @returns {Promise<{ restored: number, stale: number }>}
 */
export async function installComboPinPersistence() {
  const kv = makeKv(COMBO_PIN_KV_SCOPE);
  // Install first: a pin evicted while loading is then also removed from the store.
  setComboPinPersistence({
    save: (key, record) => kv.set(key, record),
    remove: (key) => kv.remove(key),
    clear: () => kv.clear(),
  });
  const { restored, stale } = restoreComboPins(Object.entries(await kv.getAll()));
  for (const key of stale) await kv.remove(key);
  return { restored, stale: stale.length };
}
