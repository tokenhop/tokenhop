// YAN-363 restore UX (Data & backup): pure envelope-reading contract plus
// source-level guards for the restore warning copy. No renderer in this
// harness, so copy is pinned against the component source (ponytail).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Read-only component source slice reused by the extraction below and the
// source-copy guards; kept literal so guards pin what users actually read.
const FILE = resolve(
  import.meta.dirname,
  "../../src/app/(dashboard)/dashboard/settings/sections/DataSection.js",
);
const source = readFileSync(FILE, "utf8");

// readBackupEnvelope is a pure named export; rebuilt here from its source
// slice so the pure contract runs in node without the React/Next component
// tree DataSection's imports pull in. Args/behavior identical to the export.
const match = source.match(/export const readBackupEnvelope = \(payload\) => \{([\s\S]*?)\n\};/);
if (!match) throw new Error("readBackupEnvelope source changed shape");
const readBackupEnvelope = new Function("payload", match[1]);

describe("readBackupEnvelope", () => {
  it("reports the actual v2 envelope without inventing a schema", () => {
    expect(
      readBackupEnvelope({
        formatVersion: 2,
        schemaVersion: 7,
        apiKeyStorage: { storage: "hashed", version: 1, hashKid: "kid-abc" },
      }),
    ).toEqual({
      formatVersion: 2,
      schemaVersion: 7,
      hashed: true,
      apiKeyStorageVersion: 1,
      hashKid: "kid-abc",
    });
  });

  it("treats a file without formatVersion as legacy, never hashed", () => {
    expect(readBackupEnvelope({ schemaVersion: 5, apiKeys: [{ key: "sk-x" }] })).toMatchObject({
      formatVersion: null,
      schemaVersion: 5,
      hashed: false,
      apiKeyStorageVersion: null,
    });
    // A hashed marker without formatVersion 2 is not trusted as v2.
    expect(readBackupEnvelope({ apiKeyStorage: { storage: "hashed", version: 1 } }).hashed).toBe(
      false,
    );
  });

  it("returns null for non-objects", () => {
    for (const bad of [null, undefined, [], "x", 3]) expect(readBackupEnvelope(bad)).toBeNull();
  });

  it("never surfaces secret-bearing fields", () => {
    const env = readBackupEnvelope({
      formatVersion: 2,
      apiKeyStorage: { storage: "hashed", version: 1, hashKid: "k" },
      users: [{ passwordHash: "secret" }],
      apiKeys: [{ keyHash: "h".repeat(64) }],
    });
    expect(JSON.stringify(env)).not.toMatch(/secret|passwordHash|keyHash/);
  });
});

describe("restore warning copy (source guard)", () => {
  it("keeps a destructive replacement confirmation", () => {
    expect(source).toContain("Import replaces this instance's data");
    expect(source).toContain('auth.mode === "restore"');
  });

  it("explains v2 backup contents and that the master key is not included", () => {
    expect(source).toContain("Full-instance backup (format v2)");
    expect(source).toMatch(/identities and password hashes/);
    expect(source).toMatch(/provider\s+secrets/);
    expect(source).toMatch(/master key is[\s\S]{0,40}not[\s\S]{0,20}in the file/);
    expect(source).toMatch(/provisioned on this machine/);
  });

  it("never offers browser master-key entry or upload", () => {
    expect(source).not.toMatch(/masterKey|master-key input|type="file"[\s\S]{0,80}master/i);
    expect(source).toMatch(/never entered in this page/);
  });

  it("does not claim all failures leave data untouched", () => {
    expect(source).toMatch(/missing or mismatched master key fails the pre-restore check/);
    expect(source).toMatch(/other failures mid-restore are not/);
    expect(source).not.toMatch(/all failures|every failure|always untouched/i);
  });

  it("documents restart-only activation with no runtime toggle", () => {
    expect(source).toContain("Restart to apply.");
    expect(source).toContain("restart to apply.");
    expect(source).not.toMatch(/runtime toggle|enable now/i);
  });

  it("keeps the legacy export path and password gate", () => {
    expect(source).toContain('headers: { "x-9r-password": password }');
    expect(source).toContain('if (mode === "export") await handleExport(password)');
  });
});
