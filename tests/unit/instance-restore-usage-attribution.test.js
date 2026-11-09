// YAN-1981: a hashed restore keeps live usage attribution for the workspaces
// and users it restores (native driver).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import {
  expectFailedApplyRollsBackHold,
  expectRestoreKeepsUsageAttribution,
  seedHashedSwitchOffInstance,
} from "../helpers/usageAttributionRestore.js";

vi.mock("@/lib/users/featureSwitch.js", () => ({ isMultiUserEnabled: vi.fn(async () => false) }));
vi.mock("@/lib/auth/apiKeyPrincipal.js", () => ({ clearApiKeyPrincipalCache: vi.fn() }));

let db;
beforeAll(async () => {
  db = await getAdapter();
  await seedHashedSwitchOffInstance(db);
});

describe("hashed restore usage attribution (native)", () => {
  it("keeps the attribution of restored workspaces and users only", async () => {
    expect(db.driver).not.toBe("sql.js");
    await expectRestoreKeepsUsageAttribution(db);
  });

  it("rolls the hold back with a failed apply", async () => {
    await expectFailedApplyRollsBackHold(db);
  });
});
