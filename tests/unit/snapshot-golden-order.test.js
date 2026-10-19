// YAN-1013 independent oracle (review findings M5). The other parity tests
// compare the new streaming writer/stager against itself; this file pins them
// against values derived from the ORIGINAL implementation instead:
//
//  1. Golden order: top-level key arrays for the legacy / hashed-switch-off /
//     v2 / v3 export shapes and the first-row key order of every array, taken
//     from the pre-change exportDb (commit 0a4c1919) and hardcoded here.
//  2. Bind fidelity: the 9 instance sections written by the staged import
//     (importDb, importDbStream, and the absent-section retain path) must land
//     with byte-identical SQLite storage classes and values as the original
//     bind path `insertInstanceTableSections` (still exported, unchanged).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import * as dbApi from "@/lib/db/index.js";
import { insertInstanceTableSections } from "@/lib/db/helpers/instanceSnapshotTables.js";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";
import {
  KID,
  MASTER,
  NOW,
  SECTION_TABLES,
  WS,
  bodyOf,
  clearSections,
  dumpSections,
  insertViaOracle,
  seedHashedGraph,
  trickySections,
} from "../helpers/snapshotOracle.js";

let multiUser = true;
vi.mock("@/lib/users/featureSwitch.js", () => ({
  isMultiUserEnabled: vi.fn(async () => multiUser),
}));
vi.mock("@/lib/auth/apiKeyPrincipal.js", () => ({
  clearApiKeyPrincipalCache: vi.fn(),
}));

// ---- Golden literals (derived from `git show 0a4c1919:src/lib/db/...`) -----

const GOLDEN_LEGACY_TOP = [
  "schemaVersion",
  "settings",
  "providerConnections",
  "providerNodes",
  "proxyPools",
  "apiKeys",
  "combos",
  "modelAliases",
  "disabledModels",
  "customModels",
  "mitmAlias",
  "cliToolSettings",
  "cliToolPresets",
  "pricing",
];

const GOLDEN_HASHED_OFF_TOP = [
  ...GOLDEN_LEGACY_TOP,
  "formatVersion",
  "apiKeyStorage",
  "users",
  "identities",
  "workspaces",
  "memberships",
  "tenancy",
  "gatewayVideoJobs",
];

const GOLDEN_V2_TOP = [
  ...GOLDEN_LEGACY_TOP,
  "formatVersion",
  "apiKeyStorage",
  "users",
  "identities",
  "workspaces",
  "memberships",
  "tenancy",
  "metadataCounters",
  "kv",
  "workspaceSettings",
  "userPreferences",
  "budgets",
  "connectionGrants",
  "invitations",
  "auditEvents",
  "usageHistory",
  "requestDetails",
  "usageRollup",
  "gatewayVideoJobs",
];

const GOLDEN_V3_TOP = [
  ...GOLDEN_LEGACY_TOP,
  "formatVersion",
  "apiKeyStorage",
  "users",
  "identities",
  "workspaces",
  "memberships",
  "tenancy",
  "credentialEncryption",
  "workspaceKeys",
  "metadataCounters",
  "kv",
  "workspaceSettings",
  "userPreferences",
  "budgets",
  "connectionGrants",
  "invitations",
  "auditEvents",
  "usageHistory",
  "requestDetails",
  "usageRollup",
  "gatewayVideoJobs",
];

// Column / key order of one row of each of the 9 sections.
const GOLDEN_SECTION_COLUMNS = {
  workspaceSettings: ["workspaceId", "data", "updatedAt"],
  userPreferences: ["userId", "data", "updatedAt"],
  budgets: [
    "id",
    "workspaceId",
    "scopeType",
    "scopeId",
    "window",
    "limitUsd",
    "limitTokens",
    "limitRequests",
    "softLimitPct",
    "resetAt",
    "createdByUserId",
    "createdAt",
  ],
  connectionGrants: [
    "id",
    "connectionId",
    "workspaceId",
    "userId",
    "allowedModels",
    "rpm",
    "tpm",
    "budgetId",
    "createdByUserId",
    "tosAcknowledgedAt",
    "createdAt",
    "revokedAt",
  ],
  invitations: [
    "id",
    "workspaceId",
    "role",
    "email",
    "tokenHash",
    "createdByUserId",
    "createdAt",
    "expiresAt",
    "consumedAt",
    "consumedByUserId",
    "revokedAt",
  ],
  auditEvents: [
    "id",
    "ts",
    "actorUserId",
    "actorApiKeyId",
    "via",
    "ip",
    "workspaceId",
    "action",
    "targetType",
    "targetId",
    "before",
    "after",
    "result",
  ],
  usageHistory: [
    "id",
    "timestamp",
    "provider",
    "model",
    "connectionId",
    "apiKey",
    "endpoint",
    "promptTokens",
    "completionTokens",
    "cost",
    "status",
    "tokens",
    "meta",
    "workspaceId",
    "userId",
    "apiKeyId",
    "grantId",
  ],
  requestDetails: [
    "id",
    "timestamp",
    "provider",
    "model",
    "connectionId",
    "status",
    "data",
    "workspaceId",
    "userId",
    "apiKeyId",
    "grantId",
  ],
  usageRollup: [
    "dateKey",
    "workspaceId",
    "userId",
    "apiKeyId",
    "provider",
    "model",
    "connectionId",
    "endpoint",
    "requests",
    "tokensIn",
    "tokensOut",
    "tokensCached",
    "cost",
    "latencySumMs",
    "latencyCount",
    "emptyCount",
    "latencyRequests",
    "latencyHistogram",
  ],
};

const USERS_COLS = [
  "id",
  "email",
  "username",
  "displayName",
  "instanceRole",
  "status",
  "passwordHash",
  "sessionVersion",
  "createdAt",
  "updatedAt",
  "lastLoginAt",
  "mustChangePassword",
  "instanceRoleSource",
];
const IDENTITIES_COLS = [
  "id",
  "userId",
  "provider",
  "issuer",
  "subject",
  "emailAtLink",
  "createdAt",
  "lastLoginAt",
];
const WORKSPACES_COLS = ["id", "name", "kind", "createdBy", "createdAt", "updatedAt"];
const MEMBERSHIPS_COLS = ["workspaceId", "userId", "role", "source", "createdAt"];
const PROXY_POOL_COLS = ["url", "id", "isActive", "testStatus", "createdAt", "updatedAt"];
const HASHED_API_KEY_COLS = [
  "id",
  "workspaceId",
  "userId",
  "createdByUserId",
  "keyHash",
  "hashKid",
  "prefix",
  "name",
  "machineId",
  "legacy",
  "isActive",
  "revokedAt",
  "allowedModels",
  "allowedCombos",
  "expiresAt",
  "lastUsedAt",
  "createdAt",
];
const HASHED_COMBO_COLS = [
  "id",
  "name",
  "kind",
  "models",
  "createdAt",
  "updatedAt",
  "sortOrder",
  "workspaceId",
  "createdByUserId",
];
const PLAIN_COMBO_COLS = ["id", "name", "kind", "models", "createdAt", "updatedAt"];
const OWN = ["workspaceId", "createdByUserId"];
const PLAIN_CONN_V2 = [
  "accessToken",
  "id",
  "provider",
  "authType",
  "name",
  "email",
  "priority",
  "isActive",
  "createdAt",
  "updatedAt",
  ...OWN,
];
const RAW_CONN_V3 = [
  "id",
  "provider",
  "authType",
  "name",
  "email",
  "priority",
  "isActive",
  "data",
  "createdAt",
  "updatedAt",
  ...OWN,
];

/** First-row key order of every non-section array, per export shape. */
const GOLDEN_FIRST_ROWS = {
  legacy: {
    providerConnections: [
      "accessToken",
      "z",
      "id",
      "provider",
      "authType",
      "name",
      "email",
      "priority",
      "isActive",
      "createdAt",
      "updatedAt",
    ],
    providerNodes: ["zz", "id", "type", "name", "createdAt", "updatedAt"],
    proxyPools: PROXY_POOL_COLS,
    apiKeys: ["id", "key", "name", "machineId", "isActive", "createdAt"],
    combos: PLAIN_COMBO_COLS,
  },
  hashedOff: {
    providerConnections: PLAIN_CONN_V2,
    providerNodes: ["zz", "id", "type", "name", "createdAt", "updatedAt", ...OWN],
    proxyPools: PROXY_POOL_COLS,
    apiKeys: HASHED_API_KEY_COLS,
    combos: PLAIN_COMBO_COLS,
    users: USERS_COLS,
    identities: IDENTITIES_COLS,
    workspaces: WORKSPACES_COLS,
    memberships: MEMBERSHIPS_COLS,
  },
  v2: {
    providerConnections: PLAIN_CONN_V2,
    providerNodes: ["zz", "id", "type", "name", "createdAt", "updatedAt", ...OWN],
    proxyPools: PROXY_POOL_COLS,
    apiKeys: HASHED_API_KEY_COLS,
    combos: HASHED_COMBO_COLS,
    users: USERS_COLS,
    identities: IDENTITIES_COLS,
    workspaces: WORKSPACES_COLS,
    memberships: MEMBERSHIPS_COLS,
    metadataCounters: ["key", "value"],
    kv: ["scope", "key", "value"],
    ...GOLDEN_SECTION_COLUMNS,
  },
  v3: {
    providerConnections: RAW_CONN_V3,
    providerNodes: ["id", "type", "name", "data", "createdAt", "updatedAt", ...OWN],
    proxyPools: PROXY_POOL_COLS,
    apiKeys: HASHED_API_KEY_COLS,
    combos: HASHED_COMBO_COLS,
    users: USERS_COLS,
    identities: IDENTITIES_COLS,
    workspaces: WORKSPACES_COLS,
    memberships: MEMBERSHIPS_COLS,
    workspaceKeys: ["workspaceId", "kid", "wrappedDek", "createdAt"],
    metadataCounters: ["key", "value"],
    kv: ["scope", "key", "value"],
    ...GOLDEN_SECTION_COLUMNS,
  },
};

const LATENCY_DEFAULTS = {
  latencySumMs: 0,
  latencyCount: 0,
  emptyCount: 0,
  latencyRequests: 0,
  latencyHistogram: "[0,0,0,0,0,0,0,0,0,0,0,0]",
};

/** What the original bind path stores for each tricky input row, per the schema. */
function expectedSectionRows(section, rows) {
  return rows.map((row) =>
    Object.fromEntries(
      GOLDEN_SECTION_COLUMNS[section].map((c) => [
        c,
        row[c] ?? (section === "usageRollup" ? LATENCY_DEFAULTS[c] : undefined) ?? null,
      ]),
    ),
  );
}

let db;

function seedFull() {
  seedHashedGraph(db);
  db.exec("DELETE FROM kv; DELETE FROM proxyPools; DELETE FROM identities");
  db.run(
    `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt, workspaceId, createdByUserId, sortOrder)
     VALUES('c1', 'n', 'x', '[]', ?, ?, ?, 'owner', 1)`,
    [NOW, NOW, WS],
  );
  db.run("INSERT INTO kv(scope, key, value) VALUES('pricing', 'p1', '{\"x\":1}')");
  db.run("INSERT OR REPLACE INTO _meta(key, value) VALUES('savingsTokensLifetime', '5')");
  db.run(
    `INSERT INTO identities(id, userId, provider, issuer, subject, emailAtLink, createdAt, lastLoginAt)
     VALUES('i1', 'owner', 'password', '', 's', 'e', ?, NULL)`,
    [NOW],
  );
  db.run(
    `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt, workspaceId, createdByUserId)
     VALUES('n1', 'relay', 'N', '{"zz":1}', ?, ?, ?, 'owner')`,
    [NOW, NOW, WS],
  );
  db.run(
    `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt)
     VALUES('pp', 1, 'ok', '{"url":"x"}', ?, ?)`,
    [NOW, NOW],
  );
  // Make the connection data carry an extra key so v2 spreads `accessToken` first.
  insertViaOracle(db, insertInstanceTableSections, trickySections());
}

/** Assert top-level key order and the first-row key order of every array. */
function expectShape(snapshot, top, firstRows) {
  expect(Object.keys(snapshot)).toEqual(top);
  for (const [name, keys] of Object.entries(firstRows)) {
    expect(Array.isArray(snapshot[name]), `${name} is an array`).toBe(true);
    expect(snapshot[name].length, `${name} has rows`).toBeGreaterThan(0);
    expect(Object.keys(snapshot[name][0]), `${name} first-row key order`).toEqual(keys);
  }
}

function expectSections(snapshot) {
  const tricky = trickySections();
  for (const section of SECTION_TABLES) {
    const expected = expectedSectionRows(section, tricky[section]);
    expect(snapshot[section], section).toEqual(expected);
    // JSON text equality also pins key order of every row, not just the first.
    expect(JSON.stringify(snapshot[section]), `${section} key order`).toBe(
      JSON.stringify(expected),
    );
  }
}

beforeAll(async () => {
  db = await getAdapter();
});

beforeEach(() => {
  multiUser = true;
  vi.clearAllMocks();
});

afterEach(() => {
  assertIsolatedHome();
});

// Must run first: it needs the pristine (plain, non-hashed) apiKeys table.
describe("golden export order", () => {
  it("legacy shape (switch off, plain keys)", async () => {
    multiUser = false;
    db.run("INSERT INTO kv(scope, key, value) VALUES('pricing', 'p1', '{\"x\":1}')");
    db.run(
      "INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES('k1', 'sk-x', 'n', 'm', 1, ?)",
      [NOW],
    );
    db.run(
      "INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES('c1', 'n', NULL, '[]', ?, ?)",
      [NOW, NOW],
    );
    db.run(
      "INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES('n1', 'relay', 'N', '{\"zz\":1}', ?, ?)",
      [NOW, NOW],
    );
    db.run(
      "INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES('pp', 1, 'ok', '{\"url\":\"x\"}', ?, ?)",
      [NOW, NOW],
    );
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
       VALUES('c', 'openai', 'api_key', 'Main', NULL, 1, 1, '{"accessToken":"a","z":1}', ?, ?)`,
      [NOW, NOW],
    );
    try {
      const snapshot = await dbApi.exportDb();
      expectShape(snapshot, GOLDEN_LEGACY_TOP, GOLDEN_FIRST_ROWS.legacy);
      expect(snapshot.formatVersion).toBeUndefined();
    } finally {
      db.exec(
        "DELETE FROM kv; DELETE FROM apiKeys; DELETE FROM combos; DELETE FROM providerNodes; DELETE FROM proxyPools; DELETE FROM providerConnections",
      );
    }
  });

  it("hashed keys with the multi-user switch off", async () => {
    seedFull();
    multiUser = false;
    const snapshot = await dbApi.exportDb();
    expectShape(snapshot, GOLDEN_HASHED_OFF_TOP, GOLDEN_FIRST_ROWS.hashedOff);
    expect(snapshot.formatVersion).toBe(2);
  });

  it("v2 shape (plain hashed, switch on): keys, sections and stored values", async () => {
    seedFull();
    const snapshot = await dbApi.exportDb();
    expectShape(snapshot, GOLDEN_V2_TOP, GOLDEN_FIRST_ROWS.v2);
    expect(snapshot.formatVersion).toBe(2);
    expect(Object.keys(snapshot.tenancy)).toEqual(["defaultWorkspaceId"]);
    expect(Object.keys(snapshot.apiKeyStorage)).toEqual(["storage", "version", "hashKid"]);
    expectSections(snapshot);
  });

  it("v3 shape (encrypted): keys, sections and stored values", async () => {
    seedFull();
    const { activateCredentialEncryption } = await import(
      "@/lib/db/activateCredentialEncryption.js"
    );
    await activateCredentialEncryption(db, {
      enabled: true,
      beforeServing: true,
      root: { kid: KID, key: MASTER },
    });
    const snapshot = await dbApi.exportDb();
    expectShape(snapshot, GOLDEN_V3_TOP, GOLDEN_FIRST_ROWS.v3);
    expect(snapshot.formatVersion).toBe(3);
    expect(Object.keys(snapshot.credentialEncryption)).toEqual([
      "version",
      "kekKid",
      "apiKeyHashKeyWrapped",
    ]);
    expectSections(snapshot);
  });
});

describe("bind fidelity vs the original insertInstanceTableSections", () => {
  let tricky;
  let doc;
  let oracleDump;

  beforeEach(async () => {
    tricky = trickySections();
    // Document carrying the tricky rows, built from an otherwise-empty export.
    seedHashedGraph(db);
    doc = { ...(await dbApi.exportDb()), ...structuredClone(tricky) };
    // (a) The oracle: original bind path into the same starting state.
    clearSections(db);
    insertViaOracle(db, insertInstanceTableSections, tricky);
    oracleDump = dumpSections(db);
    clearSections(db);
  });

  it("the oracle dump exercises every storage class it is meant to", () => {
    const rows = (t) => oracleDump[t];
    expect(rows("budgets")[0].limitUsd).toBe("real:5.0");
    expect(rows("budgets")[1].limitUsd).toBe("real:0.1");
    expect(rows("budgets")[1].limitTokens).toBe("integer:9007199254740991");
    expect(rows("budgets")[0].limitTokens).toBe("null:NULL");
    expect(rows("workspaceSettings")[0].updatedAt).toBe("text:''");
    expect(rows("workspaceSettings")[1].updatedAt).toBe("null:NULL");
    expect(rows("userPreferences")[1].updatedAt).toBe("text:'007'");
    expect(rows("invitations")[1].expiresAt).toBe("text:'5.0'");
    expect(rows("connectionGrants")[0].tpm).toBe("integer:9007199254740991");
    // Absent latency columns take their schema defaults.
    const absent = rows("usageRollup")[1];
    expect(absent.latencySumMs).toBe("real:0.0");
    expect(absent.latencyCount).toBe("integer:0");
    expect(absent.latencyHistogram).toBe("text:'[0,0,0,0,0,0,0,0,0,0,0,0]'");
    expect(rows("usageRollup")[2].latencySumMs).toBe("real:7.0");
    expect(rows("usageRollup")[1].cost).toBe("real:5.0");
    for (const table of SECTION_TABLES) expect(rows(table).length).toBeGreaterThan(0);
  });

  it("importDb (staged, in-memory payload) stores exactly what the oracle stores", async () => {
    await dbApi.importDb(structuredClone(doc), { masterKey: MASTER });
    expect(dumpSections(db)).toEqual(oracleDump);
  });

  it("importDbStream (staged, byte stream) stores exactly what the oracle stores", async () => {
    await dbApi.importDbStream(bodyOf(doc, 613), { masterKey: MASTER });
    expect(dumpSections(db)).toEqual(oracleDump);
  });

  it("the absent-section retain path stores exactly what the oracle stores", async () => {
    insertViaOracle(db, insertInstanceTableSections, tricky);
    const slim = structuredClone(doc);
    for (const table of SECTION_TABLES) delete slim[table];
    await dbApi.importDbStream(bodyOf(slim, 997), { masterKey: MASTER });
    expect(dumpSections(db)).toEqual(oracleDump);
  });

  it("a second export of the restored instance is byte-identical to the first", async () => {
    await dbApi.importDbStream(bodyOf(doc), { masterKey: MASTER });
    const restored = await dbApi.exportDb();
    expectSections(restored);
  });
});
