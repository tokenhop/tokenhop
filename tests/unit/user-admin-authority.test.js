// Delegated admin authority for updateUserUnscoped/deleteUserUnscoped: with
// { actorUserId }, the persisted actor and target are re-read inside the write
// transaction. Owner > admin > user/pending; self/owner targets and stale or
// disabled actors are rejected with FORBIDDEN. Legacy callers (no actorUserId)
// keep trusted behaviour.
import { beforeEach, describe, expect, it } from "vitest";

let repo;
let db;

const code = (p) => p.catch((e) => e.code);

const mk = (instanceRole, status = "active") =>
  repo
    .createUserUnscoped({ email: `${crypto.randomUUID()}@x.io`, instanceRole, passwordHash: "h" })
    .then((u) =>
      status === "active"
        ? u
        : repo.updateUserUnscoped(u.id, { status }).then(() => repo.getUserUnscoped(u.id)),
    );

const ids = () => ({
  as: (actor) => ({ actorUserId: actor.id }),
});

describe("delegated admin authority", () => {
  beforeEach(async () => {
    repo = await import("@/lib/db/repos/usersRepo.js");
    db = await (await import("@/lib/db/driver.js")).getAdapter();
    for (const t of ["memberships", "identities", "workspaces", "users"])
      db.run(`DELETE FROM ${t}`);
  });

  describe("updateUserUnscoped", () => {
    it("owner can manage admin, user and pending targets", async () => {
      const owner = await mk("owner");
      for (const role of ["admin", "user", "pending"]) {
        const target = await mk(role);
        const updated = await repo.updateUserUnscoped(
          target.id,
          { status: "disabled" },
          ids().as(owner),
        );
        expect(updated.status).toBe("disabled");
      }
    });

    it("owner can promote a user to admin", async () => {
      const owner = await mk("owner");
      const target = await mk("user");
      const updated = await repo.updateUserUnscoped(
        target.id,
        { instanceRole: "admin" },
        ids().as(owner),
      );
      expect(updated.instanceRole).toBe("admin");
    });

    it("admin can manage user/pending targets but not grant admin", async () => {
      const admin = await mk("admin");
      const user = await mk("user");
      const pending = await mk("pending");
      expect(
        (await repo.updateUserUnscoped(user.id, { status: "disabled" }, ids().as(admin))).status,
      ).toBe("disabled");
      expect(
        (await repo.updateUserUnscoped(pending.id, { displayName: "P" }, ids().as(admin)))
          .displayName,
      ).toBe("P");
      expect(
        await code(repo.updateUserUnscoped(pending.id, { instanceRole: "admin" }, ids().as(admin))),
      ).toBe("FORBIDDEN");
      // Rejected patch never landed.
      expect((await repo.getUserUnscoped(pending.id)).instanceRole).toBe("pending");
    });

    it("admin cannot touch another admin (peer escalation)", async () => {
      const admin = await mk("admin");
      const peer = await mk("admin");
      expect(
        await code(repo.updateUserUnscoped(peer.id, { status: "disabled" }, ids().as(admin))),
      ).toBe("FORBIDDEN");
      expect((await repo.getUserUnscoped(peer.id)).status).toBe("active");
    });

    it("self-modification is rejected for owner and admin actors", async () => {
      const owner = await mk("owner");
      const admin = await mk("admin");
      expect(
        await code(repo.updateUserUnscoped(owner.id, { status: "disabled" }, ids().as(owner))),
      ).toBe("FORBIDDEN");
      expect(
        await code(repo.updateUserUnscoped(admin.id, { displayName: "X" }, ids().as(admin))),
      ).toBe("FORBIDDEN");
    });

    it("owner target is rejected for any actor", async () => {
      // Only one owner may exist (idx_users_owner), so the owner is its own actor.
      const owner = await mk("owner");
      const admin = await mk("admin");
      expect(
        await code(repo.updateUserUnscoped(owner.id, { status: "disabled" }, ids().as(owner))),
      ).toBe("FORBIDDEN");
      expect(
        await code(repo.updateUserUnscoped(owner.id, { status: "disabled" }, ids().as(admin))),
      ).toBe("FORBIDDEN");
    });

    it("stale or disabled actor is rejected at write time", async () => {
      const admin = await mk("admin");
      const target = await mk("user");
      // Disable the actor via a trusted call after the caller resolved it.
      await repo.updateUserUnscoped(admin.id, { status: "disabled" });
      expect(
        await code(repo.updateUserUnscoped(target.id, { status: "disabled" }, ids().as(admin))),
      ).toBe("FORBIDDEN");
      expect((await repo.getUserUnscoped(target.id)).status).toBe("active");
      // Unknown actor id never gains authority.
      expect(
        await code(
          repo.updateUserUnscoped(target.id, { status: "disabled" }, { actorUserId: "nope" }),
        ),
      ).toBe("NOT_FOUND");
    });

    it("plain user actor has no authority", async () => {
      const actor = await mk("user");
      const target = await mk("user");
      expect(
        await code(repo.updateUserUnscoped(target.id, { status: "disabled" }, ids().as(actor))),
      ).toBe("FORBIDDEN");
    });

    it("legacy trusted callers without actorUserId keep behaviour", async () => {
      const owner = await mk("owner");
      const user = await mk("user");
      const updated = await repo.updateUserUnscoped(user.id, { instanceRole: "admin" });
      expect(updated.instanceRole).toBe("admin");
      expect(await code(repo.updateUserUnscoped(owner.id, { status: "disabled" }))).toBe(
        "OWNER_IMMUTABLE",
      );
    });
  });

  describe("deleteUserUnscoped", () => {
    it("owner can delete admin/user/pending targets", async () => {
      const owner = await mk("owner");
      for (const role of ["admin", "user", "pending"]) {
        const target = await mk(role);
        expect(await repo.deleteUserUnscoped(target.id, ids().as(owner))).toBe(true);
        expect(await repo.getUserUnscoped(target.id)).toBe(null);
      }
    });

    it("admin can delete user/pending but not admin, owner or self", async () => {
      const admin = await mk("admin");
      const owner = await mk("owner");
      const peer = await mk("admin");
      const user = await mk("user");
      expect(await repo.deleteUserUnscoped(user.id, ids().as(admin))).toBe(true);
      expect(await code(repo.deleteUserUnscoped(peer.id, ids().as(admin)))).toBe("FORBIDDEN");
      expect(await code(repo.deleteUserUnscoped(owner.id, ids().as(admin)))).toBe("FORBIDDEN");
      expect(await code(repo.deleteUserUnscoped(admin.id, ids().as(admin)))).toBe("FORBIDDEN");
      for (const survivor of [peer, owner, admin]) {
        expect(await repo.getUserUnscoped(survivor.id)).not.toBe(null);
      }
    });

    it("stale disabled actor cannot delete", async () => {
      const admin = await mk("admin");
      const target = await mk("user");
      await repo.updateUserUnscoped(admin.id, { status: "disabled" });
      expect(await code(repo.deleteUserUnscoped(target.id, ids().as(admin)))).toBe("FORBIDDEN");
      expect(await repo.getUserUnscoped(target.id)).not.toBe(null);
    });

    it("legacy trusted callers without actorUserId keep behaviour", async () => {
      const owner = await mk("owner");
      const user = await mk("user");
      expect(await repo.deleteUserUnscoped(user.id)).toBe(true);
      expect(await code(repo.deleteUserUnscoped(owner.id))).toBe("OWNER_IMMUTABLE");
    });
  });
});
