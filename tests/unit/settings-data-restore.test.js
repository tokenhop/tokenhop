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
      encrypted: false,
      portable: false,
      apiKeyStorageVersion: 1,
      hashKid: "kid-abc",
    });
  });

  it("reports v3 hashed/encrypted/portable from real sections, no invented schema", () => {
    expect(
      readBackupEnvelope({
        formatVersion: 3,
        schemaVersion: 7,
        apiKeyStorage: { storage: "hashed", hashKid: "kid-3" },
        credentialEncryption: { kekKid: "kid-kek", portable: {} },
        workspaceKeys: [{ workspaceId: "ws-default", kid: "kid-kek", wrappedDek: "{}" }],
      }),
    ).toEqual({
      formatVersion: 3,
      schemaVersion: 7,
      hashed: true,
      encrypted: true,
      portable: true,
      // v2-only field: v3 apiKeys carry no apiKeyStorage.version to read.
      apiKeyStorageVersion: null,
      hashKid: "kid-3",
    });
    // Encrypted but not passphrase-wrapped: portable stays false.
    expect(
      readBackupEnvelope({
        formatVersion: 3,
        apiKeyStorage: { storage: "hashed" },
        credentialEncryption: { kekKid: "kid-kek" },
        workspaceKeys: [],
      }),
    ).toMatchObject({ hashed: true, encrypted: true, portable: false });
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
    expect(source).toContain("headers: passwordHeaders(password)");
    expect(source).toContain('if (mode === "export") await handleExport(password)');
  });
});

// PR835 review fixes (YAN-1013: raw upload): instance-restore headers are built
// by a pure helper from the dialog's `auth` only. The body is the raw backup
// file, so the untrusted file can never inject password/passphrase/force, and
// workspace import no longer compares against a nonexistent repeat field.
const sectionsDir = "../../src/app/(dashboard)/dashboard/settings/sections";
const sharedSource = readFileSync(
  resolve(import.meta.dirname, `${sectionsDir}/backupShared.js`),
  "utf8",
);
const helperMatch = sharedSource.match(
  /export function instanceImportHeaders\(auth, forceArmed\) \{([\s\S]*?)\n\}/,
);
if (!helperMatch) throw new Error("instanceImportHeaders source changed shape");
// Rebuilt from its source slice, same as readBackupEnvelope above: runs the
// real helper body in node without pulling the React/Next component tree.
// The header-name constants are module-level in backupShared.js; read from source.
const constant = (name) => {
  const m = sharedSource.match(new RegExp(`export const ${name} = "([^"]+)";`));
  if (!m) throw new Error(`${name} source changed shape`);
  return m[1];
};
const UPLOAD_MODE_HEADER = constant("UPLOAD_MODE_HEADER");
const FORCE_HEADER = constant("FORCE_HEADER");
const PASSWORD_HEADER = constant("PASSWORD_HEADER");
const PASSWORD_B64_HEADER = constant("PASSWORD_B64_HEADER");
const encodeMatch = sharedSource.match(
  /export function encodePasswordB64\(password\) \{([\s\S]*?)\n\}/,
);
if (!encodeMatch) throw new Error("encodePasswordB64 source changed shape");
const encodePasswordB64 = new Function("password", encodeMatch[1]);
const PASSPHRASE_HEADER = constant("PASSPHRASE_HEADER");
const SSO_PROOF_HEADER = constant("SSO_PROOF_HEADER");
const instanceImportHeaders = new Function(
  "UPLOAD_MODE_HEADER",
  "FORCE_HEADER",
  "PASSWORD_B64_HEADER",
  "encodePasswordB64",
  "PASSPHRASE_HEADER",
  "SSO_PROOF_HEADER",
  "auth",
  "forceArmed",
  helperMatch[1],
).bind(
  null,
  UPLOAD_MODE_HEADER,
  FORCE_HEADER,
  PASSWORD_B64_HEADER,
  encodePasswordB64,
  PASSPHRASE_HEADER,
  SSO_PROOF_HEADER,
);

describe("instanceImportHeaders", () => {
  it("uses the server's header names", () => {
    expect(UPLOAD_MODE_HEADER).toBe("x-tokenhop-snapshot-upload");
    expect(FORCE_HEADER).toBe("x-tokenhop-import-force");
    expect(PASSWORD_HEADER).toBe("x-9r-password");
    expect(PASSWORD_B64_HEADER).toBe("x-tokenhop-password-b64");
    expect(PASSPHRASE_HEADER).toBe("x-tokenhop-backup-passphrase");
    expect(SSO_PROOF_HEADER).toBe("x-tokenhop-sso-proof");
  });

  it("marks the upload raw JSON", () => {
    const headers = instanceImportHeaders({ password: "pw" }, false);
    expect(headers[UPLOAD_MODE_HEADER]).toBe("raw");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends force only when it is explicitly armed", () => {
    expect(instanceImportHeaders({ password: "pw" }, false)).not.toHaveProperty(FORCE_HEADER);
    expect(instanceImportHeaders({ password: "pw" }, true)[FORCE_HEADER]).toBe("true");
  });

  it("sends the passphrase only when typed", () => {
    expect(instanceImportHeaders({ password: "pw" }, false)).not.toHaveProperty(PASSPHRASE_HEADER);
    expect(instanceImportHeaders({ password: "pw", passphrase: "" }, false)).not.toHaveProperty(
      PASSPHRASE_HEADER,
    );
    expect(
      instanceImportHeaders({ password: "pw", passphrase: "typed" }, false)[PASSPHRASE_HEADER],
    ).toBe("typed");
  });

  it("sends exactly one of proof or password", () => {
    const withPassword = instanceImportHeaders({ password: "pw" }, false);
    expect(withPassword[PASSWORD_B64_HEADER]).toBe(encodePasswordB64("pw"));
    expect(withPassword).not.toHaveProperty(PASSWORD_HEADER);
    expect(withPassword).not.toHaveProperty(SSO_PROOF_HEADER);
    const withProof = instanceImportHeaders({ password: "", ssoProof: "real" }, false);
    expect(withProof[SSO_PROOF_HEADER]).toBe("real");
    expect(withProof).not.toHaveProperty(PASSWORD_B64_HEADER);
    expect(withProof).not.toHaveProperty(PASSWORD_HEADER);
  });

  it("password b64 round-trips non-ASCII, edge-whitespace and emoji passwords", async () => {
    const { readPasswordHeader } = await import("@/lib/users/snapshotUpload.js");
    for (const pw of ["pw", "ÿ", "  spaced  ", "pässwörd-日本語-😀", "a+b/c=d", ""]) {
      const encoded = encodePasswordB64(pw);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      const headers = new Headers({ [PASSWORD_B64_HEADER]: encoded });
      expect(readPasswordHeader(headers)).toEqual({ value: pw });
    }
  });

  it("never mutates auth", () => {
    const auth = { password: "pw", passphrase: "z", ssoProof: "" };
    const before = structuredClone(auth);
    instanceImportHeaders(auth, true);
    expect(auth).toEqual(before);
  });

  it("BackupManager sends the raw file with helper headers, never a JSON spread", () => {
    const managerSource = readFileSync(
      resolve(import.meta.dirname, `${sectionsDir}/BackupManager.js`),
      "utf8",
    );
    expect(managerSource).toContain("headers: instanceImportHeaders(auth, forceArmed)");
    expect(managerSource).toContain("body: file");
    expect(managerSource).not.toMatch(/\{\s*\.\.\.payload,\s*password/);
    expect(managerSource).not.toContain("buildInstanceImportBody");
    expect(sharedSource).not.toContain("buildInstanceImportBody");
  });

  it("instance import passphrases must be header-safe", () => {
    const managerSource = readFileSync(
      resolve(import.meta.dirname, `${sectionsDir}/BackupManager.js`),
      "utf8",
    );
    expect(managerSource).toMatch(
      /passphraseProblem\(auth\.passphrase, auth\.passphrase, \{ headerSafe: true \}\)/,
    );
  });

  it("workspace import validates the passphrase against itself; export keeps the repeat field", () => {
    const wsSource = readFileSync(
      resolve(import.meta.dirname, `${sectionsDir}/WorkspaceBackup.js`),
      "utf8",
    );
    expect(wsSource).toMatch(/tab === "export" \? auth\.confirm : auth\.passphrase/);
  });
});
