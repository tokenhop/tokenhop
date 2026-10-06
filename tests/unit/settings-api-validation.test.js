import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalMultiUser = process.env.TOKENHOP_MULTI_USER;
let tempDir;

// Pin the users & teams switch off before featureSwitch loads (it captures the
// env override at module load). This file asserts the legacy PATCH validator;
// in established mode password edits route through ownerPassword.js, which
// requires an owner session (401 unauthenticated) and never reaches the
// 256-char boundary validator asserted below.
process.env.TOKENHOP_MULTI_USER = "off";

// YAN-359 on-rollout block reuses the real session module but pins the
// principal: ssoPolicyVisible() authenticates via getPrincipal().
vi.mock("@/lib/users/session", async (importOriginal) => ({
  ...(await importOriginal()),
  getPrincipal: vi.fn(),
}));

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-settings-validation-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalMultiUser === undefined) delete process.env.TOKENHOP_MULTI_USER;
  else process.env.TOKENHOP_MULTI_USER = originalMultiUser;
});

const settingsPatch = (body) =>
  import("@/app/api/settings/route.js").then(({ PATCH }) =>
    PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    ),
  );

describe("PATCH /api/settings validation for YAN-309 keys", () => {
  it("accepts requireLogin / requireApiKey / tunnelDashboardAccess booleans", async () => {
    const res = await settingsPatch({
      requireLogin: false,
      requireApiKey: false,
      tunnelDashboardAccess: false,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.requireLogin).toBe(false);
    expect(data.requireApiKey).toBe(false);
    expect(data.tunnelDashboardAccess).toBe(false);
    await settingsPatch({ requireLogin: true, requireApiKey: true, tunnelDashboardAccess: true });
  });

  it("rejects non-boolean security toggles", async () => {
    for (const body of [
      { requireLogin: "yes" },
      { requireApiKey: 1 },
      { tunnelDashboardAccess: "x" },
    ]) {
      const res = await settingsPatch(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
  });

  it("accepts authMode password/both/sso and ssoType oidc/saml", async () => {
    const res = await settingsPatch({ authMode: "both", ssoType: "saml" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.authMode).toBe("both");
    expect(data.ssoType).toBe("saml");
    await settingsPatch({ authMode: "password", ssoType: "oidc" });
  });

  it("rejects unknown authMode / ssoType", async () => {
    for (const body of [{ authMode: "magic" }, { ssoType: "kerberos" }, { authMode: 42 }]) {
      const res = await settingsPatch(body);
      expect(res.status).toBe(400);
    }
  });

  it("accepts OIDC fields within lengths and rejects bad URLs / overlong values", async () => {
    const good = await settingsPatch({
      oidcIssuerUrl: "https://auth.example.com/app",
      oidcClientId: "client-1",
      oidcScopes: "openid profile email",
      oidcLoginLabel: "Sign in",
    });
    expect(good.status).toBe(200);
    const badUrl = await settingsPatch({ oidcIssuerUrl: "not a url" });
    expect(badUrl.status).toBe(400);
    const tooLong = await settingsPatch({ oidcClientId: "x".repeat(300) });
    expect(tooLong.status).toBe(400);
  });

  it("accepts SAML fields within lengths and rejects bad URLs / overlong certs", async () => {
    const good = await settingsPatch({
      samlEntryPoint: "https://idp.example.com/sso",
      samlIssuer: "urn:tokenhop:sp",
      samlCert: "QUJD",
      samlLoginLabel: "Sign in with SAML SSO",
      samlAttributeEmail: "email",
      samlAttributeName: "name",
    });
    expect(good.status).toBe(200);
    expect((await settingsPatch({ samlEntryPoint: ":::bad" })).status).toBe(400);
    expect((await settingsPatch({ samlCert: "x".repeat(20000) })).status).toBe(400);
  });

  it("rejects overlong password payloads at the boundary", async () => {
    const res = await settingsPatch({
      currentPassword: "x",
      newPassword: "y".repeat(300),
    });
    expect(res.status).toBe(400);
  });

  it("accepts YAN-312 runtime flags, startPage and uiDensity", async () => {
    const res = await settingsPatch({
      requestLogsEnabled: true,
      translatorEnabled: false,
      startPage: "/dashboard/providers",
      uiDensity: "compact",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.requestLogsEnabled).toBe(true);
    expect(data.translatorEnabled).toBe(false);
    expect(data.startPage).toBe("/dashboard/providers");
    expect(data.uiDensity).toBe("compact");
    await settingsPatch({
      requestLogsEnabled: false,
      translatorEnabled: false,
      startPage: "/dashboard",
      uiDensity: "comfortable",
    });
  });

  it("rejects invalid YAN-312 flag, startPage and uiDensity values", async () => {
    for (const body of [
      { requestLogsEnabled: "yes" },
      { translatorEnabled: 1 },
      { startPage: "/login" },
      { startPage: "/dashboard/nope" },
      { uiDensity: "cozy" },
      { uiDensity: 42 },
    ]) {
      const res = await settingsPatch(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
  });
});

describe("PATCH /api/settings SSO-only lockout guard (YAN-349)", () => {
  // Earlier cases leave OIDC/SAML fields stored; start every case from a clean base.
  beforeEach(async () => {
    await settingsPatch({ authMode: "password", oidcIssuerUrl: "", samlEntryPoint: "" });
  });

  it("rejects SSO-only when the chosen protocol is not configured", async () => {
    for (const body of [
      { authMode: "sso", ssoType: "oidc" },
      { authMode: "sso", ssoType: "saml" },
      { authMode: "oidc" },
    ]) {
      const res = await settingsPatch(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Cannot enable SSO-only/);
    }
  });

  it("always accepts password and Password + SSO", async () => {
    expect((await settingsPatch({ authMode: "both", ssoType: "oidc" })).status).toBe(200);
    expect((await settingsPatch({ authMode: "password" })).status).toBe(200);
  });

  it("accepts SSO-only once OIDC is configured, keeping a stored secret on blank input", async () => {
    const configured = await settingsPatch({
      authMode: "both",
      ssoType: "oidc",
      oidcIssuerUrl: "https://idp.test",
      oidcClientId: "client",
      oidcClientSecret: "secret",
    });
    expect(configured.status).toBe(200);
    const res = await settingsPatch({ authMode: "sso", oidcClientSecret: "" });
    expect(res.status).toBe(200);
    expect((await res.json()).authMode).toBe("sso");
  });
});

const policyGet = () => import("@/app/api/settings/route.js").then(({ GET }) => GET());

describe("YAN-359 SSO group-policy keys (rollout off)", () => {
  // This file pins TOKENHOP_MULTI_USER=off, which is exactly the hidden state.
  it("GET omits all six policy keys", async () => {
    const data = await (await policyGet()).json();
    const { SSO_POLICY_KEYS } = await import("@/lib/db/repos/settingsRepo.js");
    for (const key of SSO_POLICY_KEYS) expect(data).not.toHaveProperty(key);
  });

  it("PATCH 404s any body carrying a policy key, before legacy writes", async () => {
    for (const body of [
      { ssoDefaultRole: "user" },
      { ssoGroupsClaim: "groups", ssoAllowedGroups: ["a"] },
      { ssoGroupWorkspaceMap: [{ group: "a", workspaceId: "x", role: "member" }] },
      { samlAttributeGroups: "groups" },
      { ssoAdminGroups: [] },
      { requireLogin: true, ssoDefaultRole: "admin" },
    ]) {
      const res = await settingsPatch(body);
      expect(res.status).toBe(404);
    }
    // The 404 precedes writes: nothing was stored.
    const data = await (await policyGet()).json();
    expect(data).not.toHaveProperty("ssoDefaultRole");
  });

  it("PATCH responses omit the policy keys even after unrelated writes", async () => {
    const res = await settingsPatch({ ssoLoginLabel: "hidden-check" });
    expect(res.status).toBe(200);
    const data = await res.json();
    for (const key of [
      "ssoGroupsClaim",
      "samlAttributeGroups",
      "ssoAllowedGroups",
      "ssoAdminGroups",
      "ssoGroupWorkspaceMap",
      "ssoDefaultRole",
    ]) {
      expect(data).not.toHaveProperty(key);
    }
  });
});

describe("YAN-359 SSO policy shapes (pure validator)", () => {
  it("hasSsoPolicyKeys detects exactly the six keys", async () => {
    const { hasSsoPolicyKeys } = await import("@/app/api/settings/validateSettings.js");
    expect(hasSsoPolicyKeys({ ssoDefaultRole: "pending" })).toBe(true);
    expect(hasSsoPolicyKeys({ authMode: "password" })).toBe(false);
    expect(hasSsoPolicyKeys({})).toBe(false);
  });

  it("validateSsoPolicy bounds and rejects unsafe claim paths", async () => {
    const { validateSsoPolicy } = await import("@/app/api/settings/validateSettings.js");
    expect(validateSsoPolicy({ ssoGroupsClaim: "groups" })).toBe("");
    expect(validateSsoPolicy({ ssoGroupsClaim: "a.b.c.d.e" })).toBe("");
    expect(validateSsoPolicy({ ssoGroupsClaim: "a.b.c.d.e.f" })).not.toBe("");
    expect(validateSsoPolicy({ ssoGroupsClaim: "a..b" })).not.toBe("");
    expect(validateSsoPolicy({ ssoGroupsClaim: "a.__proto__" })).not.toBe("");
    expect(validateSsoPolicy({ ssoGroupsClaim: "x".repeat(257) })).not.toBe("");
    expect(validateSsoPolicy({ ssoGroupsClaim: "" })).not.toBe("");
    expect(validateSsoPolicy({ samlAttributeGroups: "groups" })).toBe("");
    expect(validateSsoPolicy({ samlAttributeGroups: "constructor" })).not.toBe("");
    expect(validateSsoPolicy({ samlAttributeGroups: "x".repeat(257) })).not.toBe("");
  });

  it("validateSsoPolicy bounds and dedupes group lists", async () => {
    const { validateSsoPolicy } = await import("@/app/api/settings/validateSettings.js");
    expect(validateSsoPolicy({ ssoAllowedGroups: ["a", "b"] })).toBe("");
    const dedup = { ssoAdminGroups: ["a", "a", "b"] };
    expect(validateSsoPolicy(dedup)).toBe("");
    expect(dedup.ssoAdminGroups).toEqual(["a", "b"]);
    expect(validateSsoPolicy({ ssoAllowedGroups: ["", "a"] })).not.toBe("");
    expect(validateSsoPolicy({ ssoAllowedGroups: ["x".repeat(257)] })).not.toBe("");
    expect(
      validateSsoPolicy({ ssoAllowedGroups: Array.from({ length: 101 }, (_, i) => `g${i}`) }),
    ).not.toBe("");
    expect(validateSsoPolicy({ ssoAllowedGroups: "groups" })).not.toBe("");
  });

  it("validateSsoPolicy bounds the default role and workspace map", async () => {
    const { validateSsoPolicy } = await import("@/app/api/settings/validateSettings.js");
    expect(validateSsoPolicy({ ssoDefaultRole: "pending" })).toBe("");
    expect(validateSsoPolicy({ ssoDefaultRole: "user" })).toBe("");
    for (const role of ["admin", "owner", "disabled", "pending "]) {
      expect(validateSsoPolicy({ ssoDefaultRole: role })).not.toBe("");
    }
    const entry = { group: "eng", workspaceId: "w1", role: "manager" };
    expect(validateSsoPolicy({ ssoGroupWorkspaceMap: [entry] })).toBe("");
    for (const bad of [
      { group: "eng", workspaceId: "w1", role: "owner" },
      { group: "eng", workspaceId: "w1" },
      { group: "eng", workspaceId: "w1", role: "member", extra: 1 },
      { group: "", workspaceId: "w1", role: "member" },
      { group: "eng", workspaceId: "w1", role: "Member" },
    ]) {
      expect(validateSsoPolicy({ ssoGroupWorkspaceMap: [bad] })).not.toBe("");
    }
    expect(
      validateSsoPolicy({
        ssoGroupWorkspaceMap: Array.from({ length: 101 }, (_, i) => ({
          group: `g${i}`,
          workspaceId: "w1",
          role: "member",
        })),
      }),
    ).not.toBe("");
    expect(validateSsoPolicy({ ssoGroupWorkspaceMap: { g: "w1" } })).not.toBe("");
  });

  it("validateSsoWorkspaceTargets accepts shared, rejects personal and unknown", async () => {
    const { validateSsoWorkspaceTargets } = await import("@/app/api/settings/validateSettings.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?, ?, ?, NULL, ?, ?)`,
      ["ws-policy-test-shared", "Shared", "shared", now, now],
    );
    db.run(
      `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?, ?, ?, NULL, ?, ?)`,
      ["ws-policy-test-personal", "Personal", "personal", now, now],
    );
    const m = (workspaceId) => [{ group: "eng", workspaceId, role: "member" }];
    expect(await validateSsoWorkspaceTargets(m("ws-policy-test-shared"))).toBe("");
    expect(await validateSsoWorkspaceTargets(m("ws-policy-test-personal"))).not.toBe("");
    expect(await validateSsoWorkspaceTargets(m("ws-policy-test-missing"))).not.toBe("");
    expect(await validateSsoWorkspaceTargets([])).toBe("");
    expect(await validateSsoWorkspaceTargets(undefined)).toBe("");
  });
});

describe("YAN-359 SSO policy keys (rollout on)", () => {
  // featureSwitch captures TOKENHOP_MULTI_USER at module load, so flipping the
  // env needs a module reset; the temp DATA_DIR keeps the DB on disk across it.
  const owner = {
    userId: "u-owner",
    instanceRole: "owner",
    workspaceIds: [],
    activeWorkspaceId: null,
    via: "session",
  };

  beforeAll(async () => {
    process.env.TOKENHOP_MULTI_USER = "on";
    vi.resetModules();
    const db = await import("@/lib/db/index.js");
    await db.initDb();
  });

  afterAll(() => {
    process.env.TOKENHOP_MULTI_USER = "off";
  });

  beforeEach(async () => {
    const { getPrincipal } = await import("@/lib/users/session.js");
    vi.mocked(getPrincipal).mockReset().mockResolvedValue(null);
  });

  it("owner PATCHes a valid policy and then sees all six keys on GET", async () => {
    const { getPrincipal } = await import("@/lib/users/session.js");
    vi.mocked(getPrincipal).mockResolvedValue(owner);
    const res = await settingsPatch({
      ssoGroupsClaim: "groups",
      samlAttributeGroups: "groups",
      ssoAllowedGroups: ["eng"],
      ssoAdminGroups: ["ops"],
      ssoGroupWorkspaceMap: [
        { group: "eng", workspaceId: "ws-policy-test-shared", role: "member" },
      ],
      ssoDefaultRole: "pending",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const { SSO_POLICY_KEYS } = await import("@/lib/db/repos/settingsRepo.js");
    for (const key of SSO_POLICY_KEYS) expect(data).toHaveProperty(key);
    const get = await (await policyGet()).json();
    for (const key of SSO_POLICY_KEYS) expect(get).toHaveProperty(key);
    expect(get.ssoDefaultRole).toBe("pending");
  });

  it("admin holds instance.settings.manage and can PATCH policy keys", async () => {
    const { getPrincipal } = await import("@/lib/users/session.js");
    vi.mocked(getPrincipal).mockResolvedValue({ ...owner, instanceRole: "admin" });
    const res = await settingsPatch({ ssoAdminGroups: ["platform"] });
    expect(res.status).toBe(200);
    expect((await res.json()).ssoAdminGroups).toEqual(["platform"]);
  });

  it("ordinary, pending and unauthenticated principals get keys stripped and 403 before writes", async () => {
    const { getPrincipal } = await import("@/lib/users/session.js");
    const { SSO_POLICY_KEYS } = await import("@/lib/db/repos/settingsRepo.js");
    for (const principal of [
      { ...owner, instanceRole: "user" },
      { ...owner, instanceRole: "pending" },
      null,
    ]) {
      vi.mocked(getPrincipal).mockResolvedValue(principal);
      const get = await (await policyGet()).json();
      for (const key of SSO_POLICY_KEYS) expect(get).not.toHaveProperty(key);
      const res = await settingsPatch({ ssoGroupsClaim: "groups", ssoDefaultRole: "pending" });
      expect(res.status).toBe(403);
    }
    // The 403s preceded writes: the owner's stored policy is untouched.
    vi.mocked(getPrincipal).mockResolvedValue(owner);
    const get = await (await policyGet()).json();
    expect(get.ssoGroupsClaim).toBe("groups");
    expect(get.ssoAdminGroups).toEqual(["platform"]);
  });

  it("capable principal still gets 400 for invalid policy payloads", async () => {
    const { getPrincipal } = await import("@/lib/users/session.js");
    vi.mocked(getPrincipal).mockResolvedValue(owner);
    for (const body of [
      { ssoDefaultRole: "admin" },
      { ssoAllowedGroups: Array.from({ length: 101 }, (_, i) => `g${i}`) },
      { ssoGroupsClaim: "a.__proto__" },
    ]) {
      const res = await settingsPatch(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
  });
});
