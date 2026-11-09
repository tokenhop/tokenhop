// YAN-1981: the same restore scenario on the sql.js backend (both native
// adapters forced unavailable).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import {
  expectFailedApplyRollsBackHold,
  expectRestoreKeepsUsageAttribution,
  seedHashedSwitchOffInstance,
} from "../helpers/usageAttributionRestore.js";

vi.mock("@/lib/db/adapters/betterSqliteAdapter.js", () => {
  throw new Error("simulated unavailable");
});
vi.mock("@/lib/db/adapters/nodeSqliteAdapter.js", () => {
  throw new Error("simulated unavailable");
});
vi.mock("@/lib/users/featureSwitch.js", () => ({ isMultiUserEnabled: vi.fn(async () => false) }));
vi.mock("@/lib/auth/apiKeyPrincipal.js", () => ({ clearApiKeyPrincipalCache: vi.fn() }));

let db;
beforeAll(async () => {
  db = await getAdapter();
  await seedHashedSwitchOffInstance(db);
});

describe("hashed restore usage attribution (sql.js)", () => {
  it("keeps the attribution of restored workspaces and users only", async () => {
    expect(db.driver).toBe("sql.js");
    await expectRestoreKeepsUsageAttribution(db);
  });

  it("rolls the hold back with a failed apply", async () => {
    await expectFailedApplyRollsBackHold(db);
  });
});
