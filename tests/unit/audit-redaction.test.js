// YAN-367: audit redaction — scrub/encodeSnapshot units + integration:
// before/after containing secrets must persist nothing secret, while the
// allow-list survives, unknown keys drop, and >4KB values truncate.
import { beforeEach, describe, expect, it } from "vitest";
import { __test__ } from "@/lib/users/audit.js";
// auditRepo import kept for symmetry with audit-repo.test.js setup; the table
// is touched through the driver adapter's DELETE below.

const { scrub, encodeSnapshot } = __test__;

let auditFn;
let adapter;

beforeEach(async () => {
  ({ audit: auditFn } = await import("@/lib/users/audit.js"));
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  adapter.run(`DELETE FROM auditEvents`);
});

describe("scrub", () => {
  it("keeps only allow-listed keys, nested included", () => {
    expect(
      scrub({ name: "x", role: "admin", email: "a@b.c", bogus: 1, nested: { ok: 1 } }),
    ).toEqual({ name: "x", role: "admin", email: "a@b.c" });
    expect(scrub({ password: "s3cr3t", after: { token: "t" } })).toBeUndefined();
    expect(scrub({ method: "GET", path: "/api/audit", capability: "instance.audit.read" })).toEqual(
      {
        method: "GET",
        path: "/api/audit",
        capability: "instance.audit.read",
      },
    );
  });

  it("truncates strings longer than 4096 chars", () => {
    const big = `n${"o".repeat(5000)}`;
    expect(scrub({ name: big }).name).toHaveLength(4096);
    expect(scrub({ name: big }).name).toBe(big.slice(0, 4096));
  });

  it("passes numbers/booleans through, drops exotic leaves", () => {
    expect(scrub({ count: 3, enabled: true })).toEqual({ count: 3, enabled: true });
    expect(scrub({ name: Symbol("s") })).toBeUndefined();
  });

  it("keeps arrays of allowed primitive values", () => {
    expect(scrub({ keyNames: ["theme", "brand", 7] })).toEqual({ keyNames: ["theme", "brand", 7] });
    expect(scrub({ allowedModels: [{ id: "x", token: "t" }] })).toEqual({
      allowedModels: [{ id: "x" }],
    });
  });

  it("encodes snapshots as JSON or null", () => {
    expect(encodeSnapshot(undefined)).toBeNull();
    expect(encodeSnapshot({ password: "x" })).toBeNull();
    expect(JSON.parse(encodeSnapshot({ name: "x" }))).toEqual({ name: "x" });
  });
});

describe("audit() integration", () => {
  it("stores allowed keys, strips secrets, drops unknown, truncates long values", async () => {
    const secrets = {
      password: "pw-secret-aaa",
      accessToken: "at-secret-bbb",
      refreshToken: "rt-secret-ccc",
      apiKey: "key-secret-ddd",
      samlCert: "saml-secret-jjj",
      oidcClientSecret: "oidc-secret-eee",
      samlPrivateKey: "saml-secret-fff",
      cookie: "cookie-secret-ggg",
      session: "session-secret-hhh",
      token: "token-secret-iii",
    };
    const long = `L${"x".repeat(5000)}`;
    await auditFn(
      { principal: { userId: "u1", via: "session" }, ip: "127.0.0.1" },
      "settings.update",
      { type: "settings" },
      {
        before: { ...secrets, name: "before-name", bogus: "dropped", keyNames: ["a", long] },
        after: { ...secrets, name: "after-name", role: "admin", email: "a@b.c" },
      },
    );
    const row = adapter.get(`SELECT * FROM auditEvents`);
    expect(row).toMatchObject({ action: "settings.update", actorUserId: "u1", via: "session" });
    const blob = `${row.before} ${row.after}`;
    for (const v of Object.values(secrets)) expect(blob, v).not.toContain(v);
    expect(blob).not.toContain("bogus");
    const before = JSON.parse(row.before);
    const after = JSON.parse(row.after);
    expect(before).toMatchObject({ name: "before-name" });
    expect(after).toMatchObject({ name: "after-name", role: "admin", email: "a@b.c" });
    expect(before.keyNames[1]).toHaveLength(4096);
  });
});
