// YAN-2468: the app-side store keeps combo pins in the SQLite kv table, so a
// restart (fresh in-memory state) reloads them. Runs on the per-file temp DATA_DIR.
import { afterEach, describe, expect, it } from "vitest";

import { makeKv } from "@/lib/db/helpers/kvStore.js";
import { COMBO_PIN_KV_SCOPE, installComboPinPersistence } from "@/sse/services/comboPinKv.js";
import {
  comboPinKey,
  comboPins,
  setComboPinPersistence,
} from "../../open-sse/services/cacheAffinity.js";

const tick = () => new Promise((r) => setTimeout(r, 20));
const KEY = comboPinKey("w1", "w1:Frontier", "s:abc");

// A restart loses memory but not the DB: drop memory without mirroring the clear.
function simulateRestart() {
  setComboPinPersistence(null);
  comboPins.clear();
}

afterEach(async () => {
  simulateRestart();
  await makeKv(COMBO_PIN_KV_SCOPE).clear();
});

describe("combo pin kv persistence", () => {
  it("a pin written before a restart is restored after it", async () => {
    expect(await installComboPinPersistence()).toEqual({ restored: 0, stale: 0 });
    comboPins.set(KEY, "cx/gpt-x");
    await tick();
    expect(await makeKv(COMBO_PIN_KV_SCOPE).get(KEY)).toMatchObject({ value: "cx/gpt-x" });

    simulateRestart();
    expect(comboPins.peek(KEY)).toBeUndefined();
    expect(await installComboPinPersistence()).toEqual({ restored: 1, stale: 0 });
    expect(comboPins.peek(KEY)).toBe("cx/gpt-x");
  });

  it("drops stale rows at startup and mirrors deletes", async () => {
    const kv = makeKv(COMBO_PIN_KV_SCOPE);
    await kv.set("w1\nc\ns:old", { value: "p/a", createdAt: 1, touchedAt: 1 });
    expect(await installComboPinPersistence()).toEqual({ restored: 0, stale: 1 });
    expect(await kv.get("w1\nc\ns:old")).toBeNull();

    comboPins.set(KEY, "cx/gpt-x");
    await tick();
    comboPins.delete(KEY);
    await tick();
    expect(await kv.get(KEY)).toBeNull();
  });
});
