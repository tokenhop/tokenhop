import crypto, { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  unwrapWorkspaceExportDek,
  wrapWorkspaceExportDek,
} from "@/lib/db/helpers/workspaceTransferCrypto.js";

describe("portable workspace key wrapping", () => {
  it("round-trips the original nonzero key", async () => {
    const original = randomBytes(32);
    const document = await wrapWorkspaceExportDek("test passphrase", original);
    const restored = await unwrapWorkspaceExportDek(document, { passphrase: "test passphrase" });
    try {
      expect(restored.equals(original)).toBe(true);
      expect(restored.equals(Buffer.alloc(32))).toBe(false);
    } finally {
      original.fill(0);
      restored.fill(0);
    }
  });

  it.each([null, undefined, {}, [], "invalid"])(
    "rejects malformed documents: %j",
    async (document) => {
      await expect(
        unwrapWorkspaceExportDek(document, { passphrase: "test" }),
      ).rejects.toMatchObject({
        code: "PASSPHRASE_INVALID",
      });
    },
  );

  it("rejects tampered KDF, salt and envelope fields", async () => {
    const key = randomBytes(32);
    try {
      const doc = await wrapWorkspaceExportDek("test", key);
      const flip = (b64) => {
        const raw = Buffer.from(b64, "base64");
        raw[0] ^= 1;
        return raw.toString("base64");
      };
      const variants = [
        { ...doc, kdf: { ...doc.kdf, N: 262144 } },
        { ...doc, kdf: { ...doc.kdf, r: 4 } },
        { ...doc, kdf: { ...doc.kdf, p: 2 } },
        { ...doc, saltB64: flip(doc.saltB64) },
        { ...doc, wrappedDek: { ...doc.wrappedDek, iv: flip(doc.wrappedDek.iv) } },
        { ...doc, wrappedDek: { ...doc.wrappedDek, ct: flip(doc.wrappedDek.ct) } },
        { ...doc, wrappedDek: { ...doc.wrappedDek, tag: flip(doc.wrappedDek.tag) } },
        { ...doc, wrappedDek: { ...doc.wrappedDek, kid: "other" } },
      ];
      for (const variant of variants) {
        await expect(
          unwrapWorkspaceExportDek(variant, { passphrase: "test" }),
        ).rejects.toMatchObject({
          code: "PASSPHRASE_INVALID",
        });
      }
    } finally {
      key.fill(0);
    }
  });

  it("rejects invalid wrap inputs", async () => {
    await expect(wrapWorkspaceExportDek("", randomBytes(32))).rejects.toMatchObject({
      code: "PASSPHRASE_INVALID",
    });
    await expect(wrapWorkspaceExportDek("test", randomBytes(31))).rejects.toMatchObject({
      code: "PASSPHRASE_INVALID",
    });
  });

  it("rejects null options", async () => {
    await expect(unwrapWorkspaceExportDek({}, null)).rejects.toMatchObject({
      code: "PASSPHRASE_INVALID",
    });
  });

  it("rejects wrong passphrases and tampered metadata", async () => {
    const original = randomBytes(32);
    try {
      const document = await wrapWorkspaceExportDek("test passphrase", original);
      await expect(
        unwrapWorkspaceExportDek(document, { passphrase: "wrong passphrase" }),
      ).rejects.toMatchObject({ code: "PASSPHRASE_INVALID" });
      await expect(
        unwrapWorkspaceExportDek(
          { ...document, kdf: { ...document.kdf, N: 1 } },
          { passphrase: "test passphrase" },
        ),
      ).rejects.toMatchObject({ code: "PASSPHRASE_INVALID" });
    } finally {
      original.fill(0);
    }
  });

  it("rejects overlong UTF-8 passphrases before any scrypt work", async () => {
    const key = randomBytes(32);
    const spy = vi.spyOn(crypto, "scrypt");
    try {
      const doc = await wrapWorkspaceExportDek("ok", key);
      spy.mockClear();
      // 600 x 2-byte chars: 600 code units, 1200 bytes (> 1024).
      const long = "é".repeat(600);
      await expect(wrapWorkspaceExportDek(long, key)).rejects.toMatchObject({
        code: "PASSPHRASE_INVALID",
      });
      await expect(unwrapWorkspaceExportDek(doc, { passphrase: long })).rejects.toMatchObject({
        code: "PASSPHRASE_INVALID",
      });
      expect(spy).not.toHaveBeenCalled();
      // Exactly at the cap still works.
      const edge = "x".repeat(1024);
      const ok = await wrapWorkspaceExportDek(edge, key);
      (await unwrapWorkspaceExportDek(ok, { passphrase: edge })).fill(0);
    } finally {
      spy.mockRestore();
      key.fill(0);
    }
  });
});
