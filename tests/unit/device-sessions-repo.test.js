// YAN-751: device-session repo lifecycle and repo-level IDOR. Pins: per-row
// revoke, uniform NOT_FOUND, list DTO shape, sv-bump hiding, rebind, the
// 50-row cap, replacesId scoping, prune, the touch window and FK cascade.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedTenancy } from "../setup/tenancyHarness.js";

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

let s;
let db;
let repo;
let adapter;
let seq = 0;

const future = () => new Date(Date.now() + DAY).toISOString();
const past = () => new Date(Date.now() - MIN).toISOString();

async function mk(owner, extra = {}) {
  const id = extra.id ?? `sid-${++seq}`;
  const user = await db.getUserUnscoped(owner.user.id);
  await repo.createSessionUnscoped({
    id,
    userId: owner.user.id,
    sv: user.sessionVersion,
    expiresAt: future(),
    ...extra,
  });
  return id;
}

/** The observable shape of a refusal, to compare errors byte for byte. */
async function refusal(ctx, id) {
  try {
    await repo.revokeSession(ctx, id);
  } catch (err) {
    return { name: err.name, code: err.code, message: err.message };
  }
  return null;
}

const rowOf = (id) => adapter.get(`SELECT * FROM sessions WHERE id = ?`, [id]);
const ids = (rows) => rows.map((r) => r.id);

describe("device sessions repo", () => {
  beforeEach(async () => {
    db = await import("@/lib/db/index.js");
    repo = await import("@/lib/db/repos/sessionsRepo.js");
    adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    s = await seedTenancy();
    adapter.run(`DELETE FROM sessions`);
    repo.invalidateSessionCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("revoking one row leaves the same user's other row live", async () => {
    const one = await mk(s.a);
    const two = await mk(s.a);

    await repo.revokeSession(s.a.ctx, one);

    expect((await repo.getSessionForValidationUnscoped(one)).revokedAt).toBeTruthy();
    expect((await repo.getSessionForValidationUnscoped(two)).revokedAt).toBeNull();
    expect(ids(await repo.listSessions(s.a.ctx))).toEqual([two]);
  });

  it("revokeSession refuses foreign, unknown, expired, revoked and malformed ids identically", async () => {
    const aSid = await mk(s.a);
    const revoked = await mk(s.b);
    await repo.revokeSession(s.b.ctx, revoked);
    // Created last: a later login of the same user sweeps its expired rows.
    const expired = await mk(s.b, { expiresAt: past() });

    const foreign = await refusal(s.b.ctx, aSid);
    expect(foreign).toEqual({
      name: "TenancyError",
      code: "NOT_FOUND",
      message: "Session not found",
    });
    for (const id of ["no-such-sid", expired, revoked, "x' OR '1'='1", "", undefined, {}]) {
      expect(await refusal(s.b.ctx, id)).toEqual(foreign);
    }

    expect(rowOf(aSid).revokedAt).toBeNull();
    expect((await repo.getSessionForValidationUnscoped(aSid)).revokedAt).toBeNull();
    expect(rowOf(expired).revokedAt).toBeNull();
  });

  it("listSessions never includes another user's rows and omits userId/sv", async () => {
    const aSid = await mk(s.a, { userAgent: "Firefox on Linux", ip: "10.0.0.0/24", amr: "pwd" });
    const bSid = await mk(s.b);

    const forB = await repo.listSessions(s.b.ctx);
    expect(ids(forB)).toEqual([bSid]);
    expect(ids(await repo.listSessions(s.a.ctx))).toEqual([aSid]);
    for (const row of [...forB, ...(await repo.listSessions(s.a.ctx))]) {
      expect(Object.keys(row).sort()).toEqual(
        ["amr", "createdAt", "expiresAt", "id", "ip", "lastSeenAt", "userAgent"].sort(),
      );
    }
  });

  it("listSessions hides expired and revoked rows and orders by recent activity", async () => {
    const older = await mk(s.a, { createdAt: new Date(Date.now() - 2 * DAY).toISOString() });
    const newer = await mk(s.a, { createdAt: new Date(Date.now() - DAY).toISOString() });
    const gone = await mk(s.a);
    await repo.revokeSession(s.a.ctx, gone);
    const expired = await mk(s.a, { expiresAt: past() });

    expect(rowOf(expired)).toBeTruthy();
    expect(ids(await repo.listSessions(s.a.ctx))).toEqual([newer, older]);
  });

  it("a sessionVersion bump hides the stale row from listSessions", async () => {
    const stale = await mk(s.a);
    expect(ids(await repo.listSessions(s.a.ctx))).toEqual([stale]);

    expect(await db.bumpSessionVersion(s.a.user.id)).toBe(true);
    expect(await repo.listSessions(s.a.ctx)).toEqual([]);

    const fresh = await mk(s.a);
    expect(ids(await repo.listSessions(s.a.ctx))).toEqual([fresh]);
  });

  it("rebindSessionUnscoped moves a live row and refuses revoked, expired and foreign rows", async () => {
    const live = await mk(s.a);
    const revoked = await mk(s.a);
    const expired = await mk(s.a, { expiresAt: past() });
    await repo.revokeSession(s.a.ctx, revoked);
    const sv = (await db.getUserUnscoped(s.a.user.id)).sessionVersion;

    expect(await repo.rebindSessionUnscoped(live, s.a.user.id, sv, sv + 7)).toBe(true);
    expect((await repo.getSessionForValidationUnscoped(live)).sv).toBe(sv + 7);

    expect(await repo.rebindSessionUnscoped(live, s.b.user.id, sv + 7, sv + 9)).toBe(false);
    expect(await repo.rebindSessionUnscoped(revoked, s.a.user.id, sv, sv + 7)).toBe(false);
    expect(await repo.rebindSessionUnscoped(expired, s.a.user.id, sv, sv + 7)).toBe(false);
    expect(await repo.rebindSessionUnscoped("no-such-sid", s.a.user.id, sv, sv + 7)).toBe(false);

    expect(rowOf(live).sv).toBe(sv + 7);
    expect(rowOf(revoked).sv).toBe(sv);
    expect(rowOf(revoked).revokedAt).toBeTruthy();
    expect(rowOf(expired).sv).toBe(sv);
  });

  it("rebindSessionUnscoped is a compare-and-set on the expected old sv (YAN-1220)", async () => {
    const live = await mk(s.a);
    const sv = (await db.getUserUnscoped(s.a.user.id)).sessionVersion;

    expect(await repo.rebindSessionUnscoped(live, s.a.user.id, sv + 1, sv + 2)).toBe(false);
    expect(rowOf(live).sv).toBe(sv);
    expect(await repo.rebindSessionUnscoped(live, s.a.user.id, undefined, sv + 2)).toBe(false);
    expect(rowOf(live).sv).toBe(sv);

    expect(await repo.rebindSessionUnscoped(live, s.a.user.id, sv, sv + 2)).toBe(true);
    expect(rowOf(live).sv).toBe(sv + 2);
    // The row moved on: a second rebind from the old sv is stale.
    expect(await repo.rebindSessionUnscoped(live, s.a.user.id, sv, sv + 3)).toBe(false);
    expect(rowOf(live).sv).toBe(sv + 2);
  });

  it("revokeSessionUnscoped returns a boolean and never throws on a missing row", async () => {
    const sid = await mk(s.a);

    expect(await repo.revokeSessionUnscoped(sid, s.b.user.id)).toBe(false);
    expect(await repo.revokeSessionUnscoped("no-such-sid", s.a.user.id)).toBe(false);
    expect(await repo.revokeSessionUnscoped(sid, s.a.user.id)).toBe(true);
    expect(await repo.revokeSessionUnscoped(sid, s.a.user.id)).toBe(false);
  });

  it("caps a user at 50 active rows, evicting only that user's oldest", async () => {
    const bSid = await mk(s.b);
    const base = Date.now() - 3 * 60 * MIN;
    const aSids = [];
    for (let i = 0; i < 51; i++) {
      aSids.push(await mk(s.a, { createdAt: new Date(base + i * 1000).toISOString() }));
    }

    expect(rowOf(aSids[0])).toBeUndefined();
    expect(await repo.getSessionForValidationUnscoped(aSids[0])).toBeNull();
    expect(aSids.slice(1).every((id) => rowOf(id))).toBe(true);
    expect(
      adapter.get(`SELECT COUNT(*) AS n FROM sessions WHERE userId = ?`, [s.a.user.id]).n,
    ).toBe(50);
    expect(rowOf(bSid)).toBeTruthy();
  });

  it("evicts by least recent activity and never the row just inserted", async () => {
    const base = Date.now() - 3 * 60 * MIN;
    const sids = [];
    for (let i = 0; i < 50; i++) {
      sids.push(await mk(s.a, { createdAt: new Date(base + i * 1000).toISOString() }));
    }
    // The oldest-created row was seen most recently; the second-oldest never.
    adapter.run(`UPDATE sessions SET lastSeenAt = ? WHERE id = ?`, [
      new Date(Date.now() - MIN).toISOString(),
      sids[0],
    ]);
    // A new row created long ago would sort first by createdAt: it must survive.
    const fresh = await mk(s.a, { createdAt: new Date(base - DAY).toISOString() });

    expect(rowOf(fresh)).toBeTruthy();
    expect(rowOf(sids[0])).toBeTruthy();
    expect(rowOf(sids[1])).toBeUndefined();
    expect(
      adapter.get(`SELECT COUNT(*) AS n FROM sessions WHERE userId = ?`, [s.a.user.id]).n,
    ).toBe(50);
  });

  it("a new login deletes this user's revoked rows older than 1 hour only", async () => {
    const oldRevoked = await mk(s.a);
    const recentRevoked = await mk(s.a);
    const otherUser = await mk(s.b);
    for (const id of [oldRevoked, recentRevoked, otherUser]) {
      adapter.run(`UPDATE sessions SET revokedAt = ? WHERE id = ?`, [
        new Date(Date.now() - (id === recentRevoked ? 5 * MIN : 2 * 60 * MIN)).toISOString(),
        id,
      ]);
    }

    await mk(s.a);

    expect(rowOf(oldRevoked)).toBeUndefined();
    expect(rowOf(recentRevoked)).toBeTruthy();
    expect(rowOf(otherUser)).toBeTruthy();
  });

  it("replacesId deletes only a same-user row", async () => {
    const aSid = await mk(s.a);

    await mk(s.b, { replacesId: aSid });
    expect(rowOf(aSid)).toBeTruthy();

    await mk(s.a, { replacesId: aSid });
    expect(rowOf(aSid)).toBeUndefined();
    expect(await repo.getSessionForValidationUnscoped(aSid)).toBeNull();
  });

  it("a new login sweeps that user's expired rows only", async () => {
    const aOld = await mk(s.a, { expiresAt: past() });
    const bOld = await mk(s.b, { expiresAt: past() });

    await mk(s.a);

    expect(rowOf(aOld)).toBeUndefined();
    expect(rowOf(bOld)).toBeTruthy();
  });

  it("pruneExpiredSessionsUnscoped deletes only expired rows", async () => {
    const liveA = await mk(s.a);
    const revokedLive = await mk(s.b);
    await repo.revokeSession(s.b.ctx, revokedLive);
    const oldA = await mk(s.a, { expiresAt: past() });
    const oldB = await mk(s.b, { expiresAt: past() });
    await repo.getSessionForValidationUnscoped(oldA);

    expect(await repo.pruneExpiredSessionsUnscoped(new Date().toISOString())).toBe(2);

    expect(rowOf(oldA)).toBeUndefined();
    expect(rowOf(oldB)).toBeUndefined();
    expect(await repo.getSessionForValidationUnscoped(oldA)).toBeNull();
    expect(rowOf(liveA)).toBeTruthy();
    expect(rowOf(revokedLive)).toBeTruthy();
  });

  it("touchSessionUnscoped writes lastSeenAt at most once per 5-minute window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2030-01-01T00:00:00.000Z");
    vi.setSystemTime(t0);
    const sid = await mk(s.a, { expiresAt: new Date(t0.getTime() + DAY).toISOString() });
    expect(rowOf(sid).lastSeenAt).toBeNull();

    await repo.touchSessionUnscoped(sid);
    const first = rowOf(sid).lastSeenAt;
    expect(first).toBe(t0.toISOString());

    vi.setSystemTime(new Date(t0.getTime() + MIN));
    await repo.touchSessionUnscoped(sid);
    expect(rowOf(sid).lastSeenAt).toBe(first);

    vi.setSystemTime(new Date(t0.getTime() + 6 * MIN));
    await repo.touchSessionUnscoped(sid);
    expect(rowOf(sid).lastSeenAt).toBe(new Date(t0.getTime() + 6 * MIN).toISOString());
  });

  it("touchSessionUnscoped does not touch a revoked row", async () => {
    const sid = await mk(s.a);
    await repo.revokeSession(s.a.ctx, sid);

    await repo.touchSessionUnscoped(sid);

    expect(rowOf(sid).lastSeenAt).toBeNull();
  });

  it("deleting the user cascades its rows (foreign_keys ON)", async () => {
    expect(adapter.get(`PRAGMA foreign_keys`).foreign_keys).toBe(1);
    const aSid = await mk(s.a);
    const bSid = await mk(s.b);

    expect(await db.deleteUserUnscoped(s.b.user.id)).toBe(true);

    expect(rowOf(bSid)).toBeUndefined();
    expect(rowOf(aSid)).toBeTruthy();
  });
});
