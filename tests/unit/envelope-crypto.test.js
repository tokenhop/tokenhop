// YAN-365 C2 (D1/D2/D10): pure AES-256-GCM envelope codec — frozen AAD
// vectors, tamper/swap matrix, bounds and uniform safe failures. No DB here.
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_FIELD_ALLOWLIST,
  MAX_SECRET_BYTES,
  buildAad,
  buildDekWrapAad,
  buildHashKeyWrapAad,
  decryptBytes,
  encryptBytes,
  isEnvelopeShape,
} from "@/lib/security/envelope.js";

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const KEK = crypto.randomBytes(32);
const CONN_ID = "22222222-2222-4222-8222-222222222222";
const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_DEFAULT = "00000000-0000-4000-8000-000000000000";
const NODE_ID = "33333333-3333-4333-8333-333333333333";

const connAad = (field) =>
  buildAad({ table: "providerConnections", rowId: CONN_ID, workspaceId: WS_A, field });

describe("D1 frozen AAD vectors", () => {
  it("asserts the six exact strings and their SHA-256", () => {
    const vectors = [
      [
        connAad("refreshToken"),
        "v1|providerConnections|22222222-2222-4222-8222-222222222222|11111111-1111-4111-8111-111111111111|refreshToken",
        "0c364587c19a4ddad08085641d9368dd32b20b9921e5592f2a01e457259d7c1c",
      ],
      [
        connAad("providerSpecificData.clientSecret"),
        "v1|providerConnections|22222222-2222-4222-8222-222222222222|11111111-1111-4111-8111-111111111111|providerSpecificData.clientSecret",
        "48fc66c5f4ca0e4d22c9091c412cc36cebc55c92b79ac13649ac331458eb1117",
      ],
      [
        buildAad({ table: "providerNodes", rowId: NODE_ID, workspaceId: WS_A, field: "apiKey" }),
        "v1|providerNodes|33333333-3333-4333-8333-333333333333|11111111-1111-4111-8111-111111111111|apiKey",
        "7024dbdb9768cba746cd058531555ea63312995936def84f1fcb1cec2cdc5fc5",
      ],
      [
        buildAad({
          table: "settings",
          rowId: "1",
          workspaceId: WS_DEFAULT,
          field: "oidcClientSecret",
        }),
        "v1|settings|1|00000000-0000-4000-8000-000000000000|oidcClientSecret",
        "61bfbc36d1db3d2d1816e593816329e80069b3637c276c26c2148cc2b9e317c3",
      ],
      [
        buildDekWrapAad(WS_A, "dk_0123456789abcdef"),
        "v1|workspaceKeys|11111111-1111-4111-8111-111111111111|11111111-1111-4111-8111-111111111111|dek:dk_0123456789abcdef",
        "8525b911992f9f5d565da8e36e1f1871d9318a13858f1a7c14d27df938003dfc",
      ],
      [
        buildHashKeyWrapAad(WS_DEFAULT, "0123456789abcdef"),
        "v1|_meta|apiKeyHashKey|00000000-0000-4000-8000-000000000000|hashKid:0123456789abcdef",
        "4e1f3471539330d57d2937768c23e4491aea963aca5c9f949ad37f0ae5754adc",
      ],
    ];
    for (const [built, want, wantHash] of vectors) {
      expect(built).toBe(want);
      expect(sha256(built)).toBe(wantHash);
    }
  });

  it("throws before any cipher call on bad components", () => {
    const base = {
      table: "providerConnections",
      rowId: CONN_ID,
      workspaceId: WS_A,
      field: "refreshToken",
    };
    const bad = (patch) => () => buildAad({ ...base, ...patch });
    for (const evil of ["a|b", "a\nb", "a\u0000b", "a\u007fb", ""]) {
      expect(bad({ rowId: evil })).toThrow(/rowId/);
      expect(bad({ workspaceId: evil })).toThrow(/workspaceId/);
      expect(bad({ field: evil })).toThrow(/field/);
    }
    expect(bad({ workspaceId: null })).toThrow();
    expect(bad({ workspaceId: undefined })).toThrow();
    expect(bad({ rowId: 42 })).toThrow();
    expect(bad({ table: "users" })).toThrow(/table/);
    // A field from another table's allow-list is not on this table's list.
    expect(bad({ field: "oidcClientSecret" })).toThrow(/allow-list/);
    expect(bad({ field: "password" })).toThrow(/allow-list/);
    expect(() => buildDekWrapAad("a|b", "dk_x")).toThrow();
    expect(() => buildDekWrapAad(WS_A, "dk|x")).toThrow();
    expect(() => buildHashKeyWrapAad("", "k")).toThrow();
  });

  it("freezes the D10 coverage allow-list", () => {
    expect(CREDENTIAL_FIELD_ALLOWLIST.providerConnections).toEqual([
      "accessToken",
      "refreshToken",
      "idToken",
      "apiKey",
      "providerSpecificData.clientSecret",
      "providerSpecificData.copilotToken",
      "providerSpecificData.idToken",
      "providerSpecificData.firebaseIdToken",
      "providerSpecificData.mimoPassToken",
      "providerSpecificData.cookie",
      "providerSpecificData.apiKey",
      "providerSpecificData.secretAccessKey",
    ]);
    expect(CREDENTIAL_FIELD_ALLOWLIST.settings).toEqual([
      "oidcClientSecret",
      "samlPrivateKey",
      "samlDecryptionKey",
      "samlSigningKey",
      "mitmSudoEncrypted",
    ]);
    expect(CREDENTIAL_FIELD_ALLOWLIST.providerNodes).toContain("apiKey");
  });
});

describe("C2 codec round-trip and tamper", () => {
  it("round-trips and uses a fresh random IV per encryption", () => {
    const aad = connAad("refreshToken");
    const dek = crypto.randomBytes(32);
    const a = encryptBytes(dek, "dk_aaaaaaaaaaaaaaaa", Buffer.from("SENTINEL-one"), aad);
    const b = encryptBytes(dek, "dk_aaaaaaaaaaaaaaaa", Buffer.from("SENTINEL-one"), aad);
    expect(a.v).toBe(1);
    expect(a.kid).toBe("dk_aaaaaaaaaaaaaaaa");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(decryptBytes(dek, a, aad).toString("utf8")).toBe("SENTINEL-one");
    expect(decryptBytes(dek, b, aad).toString("utf8")).toBe("SENTINEL-one");
  });

  const flip = (s) => (s[0] === "A" ? `B${s.slice(1)}` : `A${s.slice(1)}`);

  it("rejects a single flipped byte in iv, ct and tag with one uniform failure", () => {
    const dek = crypto.randomBytes(32);
    const aad = connAad("accessToken");
    const env = encryptBytes(dek, "dk_bbbbbbbbbbbbbbbb", Buffer.from("SENTINEL-two"), aad);
    const codes = [];
    const msgs = [];
    for (const part of ["iv", "ct", "tag"]) {
      const bad = { ...env, [part]: flip(env[part]) };
      try {
        decryptBytes(dek, bad, aad);
        throw new Error(`tampered ${part} decrypted`);
      } catch (e) {
        codes.push(e.code);
        msgs.push(e.message);
      }
    }
    expect(codes).toEqual(["DECRYPT_FAILED", "DECRYPT_FAILED", "DECRYPT_FAILED"]);
    expect(new Set(msgs).size).toBe(1);
  });

  it("rejects malformed envelopes before any allocation or cipher call", () => {
    const dek = crypto.randomBytes(32);
    const aad = connAad("idToken");
    const env = encryptBytes(dek, "dk_cccccccccccccccc", Buffer.from("x"), aad);
    const bad = (mutate) => {
      const clone = { ...env, ...mutate };
      try {
        decryptBytes(dek, clone, aad);
        return null;
      } catch (e) {
        return e.code;
      }
    };
    expect(bad({ v: 2 })).toBe("ENVELOPE_INVALID");
    expect(bad({ v: "1" })).toBe("ENVELOPE_INVALID");
    expect(bad({ kid: "" })).toBe("ENVELOPE_INVALID");
    expect(bad({ kid: 7 })).toBe("ENVELOPE_INVALID");
    expect(bad({ iv: "AAAAAAAAAAAAAA" })).toBe("ENVELOPE_INVALID"); // 14 chars, %4 != 0
    expect(bad({ iv: "AAAAAAAAAAAAAAAA=" })).toBe("ENVELOPE_INVALID"); // wrong length
    expect(bad({ iv: ` ${env.iv}` })).toBe("ENVELOPE_INVALID"); // non-canonical
    expect(bad({ iv: `_${env.iv.slice(1)}` })).toBe("ENVELOPE_INVALID"); // url-safe alphabet
    expect(bad({ tag: "AAAAAAAAAAAAAAAAAAAAAAAA" })).toBe("ENVELOPE_INVALID"); // 18 bytes
    expect(bad({ ct: "" })).not.toBe("ENVELOPE_INVALID"); // empty ct is authenticated GCM, not a shape error
    expect(bad({ extra: 1 })).toBe("ENVELOPE_INVALID"); // exact key set
    expect(decryptBytes(dek, { ...env, v: 1 }, aad).toString()).toBe("x");
    for (const notEnv of [null, "string", 1, [], Buffer.alloc(4)]) {
      let code = "none";
      try {
        decryptBytes(dek, notEnv, aad);
      } catch (e) {
        code = e.code;
      }
      expect(code).toBe("ENVELOPE_INVALID");
    }
  });

  it("enforces the 64 KiB bound on plaintext and encoded ciphertext", () => {
    const dek = crypto.randomBytes(32);
    const aad = connAad("apiKey");
    expect(MAX_SECRET_BYTES).toBe(65536);
    const big = encryptBytes(dek, "dk-dddddddddddddddd", Buffer.alloc(65536, 0x61), aad);
    expect(decryptBytes(dek, big, aad)).toHaveLength(65536);
    let over = null;
    try {
      encryptBytes(dek, "dk-dddddddddddddddd", Buffer.alloc(65537, 0x61), aad);
    } catch (e) {
      over = e.code;
    }
    expect(over).toBe("ENVELOPE_INVALID");
    // An oversized encoded ct string is rejected before decode/alloc.
    const huge = "A".repeat(87384 + 4);
    let hugeCode = null;
    try {
      decryptBytes(dek, { v: 1, kid: "k", iv: big.iv, ct: huge, tag: big.tag }, aad);
    } catch (e) {
      hugeCode = e.code;
    }
    expect(hugeCode).toBe("ENVELOPE_INVALID");
  });

  it("rejects a change of each AAD component alone", () => {
    const dek = crypto.randomBytes(32);
    const env = encryptBytes(
      dek,
      "dk_eeeeeeeeeeeeeeee",
      Buffer.from("SENTINEL-three"),
      buildAad({
        table: "providerConnections",
        rowId: CONN_ID,
        workspaceId: WS_A,
        field: "refreshToken",
      }),
    );
    const wrong = (aad) => {
      try {
        decryptBytes(dek, env, aad);
        return null;
      } catch (e) {
        return e.code;
      }
    };
    expect(
      wrong(
        buildAad({
          table: "providerNodes",
          rowId: CONN_ID,
          workspaceId: WS_A,
          field: "refreshToken",
        }),
      ),
    ).toBe("DECRYPT_FAILED");
    expect(
      wrong(
        buildAad({
          table: "providerConnections",
          rowId: "99999999-9999-4999-8999-999999999999",
          workspaceId: WS_A,
          field: "refreshToken",
        }),
      ),
    ).toBe("DECRYPT_FAILED");
    expect(
      wrong(
        buildAad({
          table: "providerConnections",
          rowId: CONN_ID,
          workspaceId: WS_DEFAULT,
          field: "refreshToken",
        }),
      ),
    ).toBe("DECRYPT_FAILED");
    expect(
      wrong(
        buildAad({
          table: "providerConnections",
          rowId: CONN_ID,
          workspaceId: WS_A,
          field: "accessToken",
        }),
      ),
    ).toBe("DECRYPT_FAILED");
  });

  it("rejects swaps between fields, rows, workspaces and tables", () => {
    const dek = crypto.randomBytes(32);
    const connId2 = "44444444-4444-4444-8444-444444444444";
    const enc = (aad, kid) => encryptBytes(dek, kid, Buffer.from("SENTINEL-swap"), aad);
    const reject = (env, aad) => {
      try {
        decryptBytes(dek, env, aad);
        return null;
      } catch (e) {
        return e.code;
      }
    };
    // Same row, two fields.
    const tokenA = enc(connAad("accessToken"), "dk_1111111111111111");
    expect(reject(tokenA, connAad("refreshToken"))).toBe("DECRYPT_FAILED");
    // Two rows.
    const row1 = enc(
      buildAad({
        table: "providerConnections",
        rowId: CONN_ID,
        workspaceId: WS_A,
        field: "apiKey",
      }),
      "dk_1111111111111111",
    );
    expect(
      reject(
        row1,
        buildAad({
          table: "providerConnections",
          rowId: connId2,
          workspaceId: WS_A,
          field: "apiKey",
        }),
      ),
    ).toBe("DECRYPT_FAILED");
    // Two workspaces.
    expect(
      reject(
        enc(
          buildAad({
            table: "providerConnections",
            rowId: CONN_ID,
            workspaceId: WS_A,
            field: "apiKey",
          }),
          "dk_1",
        ),
        buildAad({
          table: "providerConnections",
          rowId: CONN_ID,
          workspaceId: WS_DEFAULT,
          field: "apiKey",
        }),
      ),
    ).toBe("DECRYPT_FAILED");
    // connection <-> node.
    expect(
      reject(
        enc(connAad("apiKey"), "dk_2"),
        buildAad({ table: "providerNodes", rowId: CONN_ID, workspaceId: WS_A, field: "apiKey" }),
      ),
    ).toBe("DECRYPT_FAILED");
    // connection <-> settings.
    expect(
      reject(
        enc(connAad("apiKey"), "dk_3"),
        buildAad({ table: "settings", rowId: "1", workspaceId: WS_A, field: "oidcClientSecret" }),
      ),
    ).toBe("DECRYPT_FAILED");
    // nested <-> top-level field of one row.
    expect(reject(enc(connAad("apiKey"), "dk_4"), connAad("providerSpecificData.apiKey"))).toBe(
      "DECRYPT_FAILED",
    );
    // DEK wrap <-> hash-key wrap domain.
    const dekWrap = enc(buildDekWrapAad(WS_A, "dk_0123456789abcdef"), "kek-kid");
    expect(reject(dekWrap, buildHashKeyWrapAad(WS_A, "0123456789abcdef"))).toBe("DECRYPT_FAILED");
    expect(reject(dekWrap, buildDekWrapAad(WS_DEFAULT, "dk_0123456789abcdef"))).toBe(
      "DECRYPT_FAILED",
    );
  });

  it("rejects the wrong DEK and the wrong KEK", () => {
    const aad = connAad("refreshToken");
    const env = encryptBytes(KEK, "dk_9999999999999999", Buffer.from("SENTINEL-key"), aad);
    expect(decryptBytes(KEK, env, aad).toString()).toBe("SENTINEL-key");
    let code = null;
    try {
      decryptBytes(crypto.randomBytes(32), env, aad);
    } catch (e) {
      code = e.code;
    }
    expect(code).toBe("DECRYPT_FAILED");
    let shortKey = null;
    try {
      decryptBytes(Buffer.alloc(16), env, aad);
    } catch (e) {
      shortKey = e.code;
    }
    expect(shortKey).toBe("KEY_INVALID");
    let shortEnc = null;
    try {
      encryptBytes(Buffer.alloc(31), "k", Buffer.from("x"), aad);
    } catch (e) {
      shortEnc = e.code;
    }
    expect(shortEnc).toBe("KEY_INVALID");
  });

  it("failures carry a typed code and never echo key, iv, ct, tag or plaintext", () => {
    const dek = crypto.randomBytes(32);
    const secret = "SENTINEL-never-leak";
    const env = encryptBytes(
      dek,
      "dk_7777777777777777",
      Buffer.from(secret),
      connAad("refreshToken"),
    );
    const messages = [];
    for (const [badEnv, aad] of [
      [{ ...env, tag: flip(env.tag) }, connAad("refreshToken")],
      [{ ...env, v: 2 }, connAad("refreshToken")],
      [env, connAad("apiKey")],
    ]) {
      try {
        decryptBytes(dek, badEnv, aad);
      } catch (e) {
        messages.push(e);
      }
    }
    for (const e of messages) {
      expect(typeof e.code).toBe("string");
      expect(e.message).not.toContain(env.iv);
      expect(e.message).not.toContain(env.ct);
      expect(e.message).not.toContain(env.tag);
      expect(e.message).not.toContain(secret);
      expect(e.message).not.toContain(dek.toString("base64"));
    }
  });

  it("isEnvelopeShape is the strict envelope predicate", () => {
    const dek = crypto.randomBytes(32);
    const env = encryptBytes(dek, "dk_8888888888888888", Buffer.from("v"), connAad("refreshToken"));
    expect(isEnvelopeShape(env)).toBe(true);
    expect(isEnvelopeShape({ ...env, v: 2 })).toBe(false);
    expect(isEnvelopeShape({ ...env, extra: true })).toBe(false);
    expect(isEnvelopeShape({ ...env, kid: "" })).toBe(false);
    expect(isEnvelopeShape("ivHex:tagHex:ctHex")).toBe(false);
    expect(isEnvelopeShape(null)).toBe(false);
    expect(isEnvelopeShape({ v: 1, kid: "k", iv: "AAAA", ct: "AAAA", tag: "AAAA" })).toBe(false); // wrong lengths
  });
});
