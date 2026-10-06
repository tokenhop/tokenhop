// SSO ownership transfer completion against a real DB: valid OIDC/SAML
// transfers swap the owner row with sv bumps, stale auth / wrong identity /
// wrong provider / sv drift all fail closed. Only the switch is mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ isMultiUserEnabled: vi.fn(async () => true) }));
vi.mock("@/lib/users/featureSwitch", () => ({ isMultiUserEnabled: mocks.isMultiUserEnabled }));

const { completeSsoOwnershipTransfer } = await import("@/lib/users/ssoOwnershipTransfer.js");
const repo = await import("@/lib/db/repos/usersRepo.js");
const identities = await import("@/lib/db/repos/identitiesRepo.js");

const NOW = Date.parse("2026-10-06T12:00:00Z");
const stateFor = (owner, target, over = {}) => ({
  ownerId: owner.id,
  sessionVersion: owner.sessionVersion,
  toUserId: target.id,
  provider: "oidc",
  issuer: "https://idp.example.com",
  subject: "owner-sub",
  startedAt: NOW - 30_000,
  ...over,
});
const complete = (owner, target, over = {}) =>
  completeSsoOwnershipTransfer({
    state: stateFor(owner, target, over.state),
    provider: over.provider ?? "oidc",
    issuer: over.issuer ?? "https://idp.example.com",
    subject: over.subject ?? "owner-sub",
    authenticatedAtMs: over.authenticatedAtMs ?? NOW - 10_000,
    now: over.now ?? NOW,
  });

let db;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.isMultiUserEnabled.mockResolvedValue(true);
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  for (const t of ["memberships", "identities", "workspaces", "users"]) db.run(`DELETE FROM ${t}`);
});

const seed = async ({ provider = "oidc" } = {}) => {
  const owner = await repo.createUserUnscoped({
    email: `${crypto.randomUUID()}@x.io`,
    instanceRole: "owner",
  });
  const target = await repo.createUserUnscoped({
    email: `${crypto.randomUUID()}@x.io`,
    instanceRole: "user",
  });
  await identities.linkIdentityUnscoped(owner.id, {
    provider,
    issuer: "https://idp.example.com",
    subject: "owner-sub",
  });
  return { owner, target };
};

describe.each([["oidc"], ["saml"]])("valid %s transfer", (provider) => {
  it("swaps owner, bumps both sv, returns safe metadata", async () => {
    const { owner, target } = await seed({ provider });
    const out = await complete(owner, target, {
      provider,
      state: { provider },
    });
    expect(out).toMatchObject({ id: target.id, instanceRole: "owner" });
    expect(out).not.toHaveProperty("sessionVersion");
    expect(await repo.getUserUnscoped(owner.id)).toMatchObject({
      instanceRole: "admin",
      sessionVersion: 2,
    });
    expect(await repo.getUserUnscoped(target.id)).toMatchObject({
      instanceRole: "owner",
      sessionVersion: 2,
    });
    expect((await repo.getOwnerUnscoped()).id).toBe(target.id);
  });
});

describe("fail closed", () => {
  it("stale auth (>5m) -> STALE, roles unchanged", async () => {
    const { owner, target } = await seed();
    await expect(
      complete(owner, target, { authenticatedAtMs: NOW - 301_000 }),
    ).rejects.toMatchObject({
      code: "STALE",
    });
    expect((await repo.getOwnerUnscoped()).id).toBe(owner.id);
  });

  it("identity belongs to another user -> FORBIDDEN", async () => {
    const { owner, target } = await seed();
    const other = await repo.createUserUnscoped({
      email: `${crypto.randomUUID()}@x.io`,
      instanceRole: "user",
    });
    await identities.linkIdentityUnscoped(other.id, {
      provider: "oidc",
      issuer: "https://evil.example.com",
      subject: "other-sub",
    });
    await expect(
      complete(owner, target, {
        issuer: "https://evil.example.com",
        subject: "other-sub",
        state: {
          issuer: "https://evil.example.com",
          subject: "other-sub",
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await repo.getOwnerUnscoped()).id).toBe(owner.id);
  });

  it("unlinked identity -> FORBIDDEN", async () => {
    const { owner, target } = await seed();
    db.run("DELETE FROM identities");
    await expect(complete(owner, target, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await repo.getOwnerUnscoped()).id).toBe(owner.id);
  });

  it("provider mismatch vs state -> FORBIDDEN", async () => {
    const { owner, target } = await seed();
    await expect(complete(owner, target, { provider: "saml" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await repo.getOwnerUnscoped()).id).toBe(owner.id);
  });

  it("issuer/subject mismatch vs state -> FORBIDDEN", async () => {
    const { owner, target } = await seed();
    await expect(complete(owner, target, { subject: "attacker-sub" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await repo.getOwnerUnscoped()).id).toBe(owner.id);
  });

  it("sessionVersion drift -> STALE", async () => {
    const { owner, target } = await seed();
    await repo.bumpSessionVersion(owner.id);
    await expect(complete(owner, target, {})).rejects.toMatchObject({ code: "STALE" });
    expect(await repo.getUserUnscoped(target.id)).toMatchObject({ instanceRole: "user" });
  });

  it("multi-user off -> FORBIDDEN", async () => {
    const { owner, target } = await seed();
    mocks.isMultiUserEnabled.mockResolvedValue(false);
    await expect(complete(owner, target, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await repo.getOwnerUnscoped()).id).toBe(owner.id);
  });
});
