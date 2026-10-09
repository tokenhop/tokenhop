import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  isPassphraseWrapShape,
  unwrapPortableKeys,
  wrapPortableKeys,
} from "@/lib/security/passphraseWrap.js";

describe("portable instance key bundle", () => {
  it("round-trips the API hash key and workspace data keys", async () => {
    const hashKey = randomBytes(32);
    const dek = randomBytes(32);
    const bundle = await wrapPortableKeys({ passphrase: "portable", hashKey, deks: { ws: dek } });
    expect(isPassphraseWrapShape(bundle)).toBe(true);
    const restored = await unwrapPortableKeys(bundle, { passphrase: "portable" });
    try {
      expect(restored.hashKey.equals(hashKey)).toBe(true);
      expect(restored.deks.get("ws").equals(dek)).toBe(true);
    } finally {
      for (const key of [hashKey, dek, restored.hashKey, ...restored.deks.values()]) key.fill(0);
    }
  });

  it("rejects a wrong passphrase and unexpected fields", async () => {
    const bundle = await wrapPortableKeys({
      passphrase: "portable",
      hashKey: randomBytes(32),
      deks: { ws: randomBytes(32) },
    });
    await expect(unwrapPortableKeys(bundle, { passphrase: "wrong" })).rejects.toMatchObject({
      code: "PASSPHRASE_WRAP_INVALID",
    });
    await expect(
      unwrapPortableKeys({ ...bundle, extra: true }, { passphrase: "portable" }),
    ).rejects.toMatchObject({ code: "PASSPHRASE_WRAP_INVALID" });
  });
});
