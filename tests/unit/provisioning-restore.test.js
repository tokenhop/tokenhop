// CodeRabbit #896 (MEDIUM 4249943473): the unsaved preview draft survives the
// full-page IdP round trip — the one-shot result carries the evaluated policy
// back and the form restores it without losing the saved baseline.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toDraft, toPayload } from "@/app/(dashboard)/dashboard/admin/provisioning/policyDraft.js";

const read = (rel) =>
  readFileSync(
    resolve(import.meta.dirname, "../../src/app/(dashboard)/dashboard/admin/provisioning", rel),
    "utf8",
  );
const form = read("ProvisioningForm.js");

describe("draft restore wiring", () => {
  it("restores the result policy once, from memory only", () => {
    // Restore happens exactly once per result object (object identity guard).
    expect(form).toContain("restoredFor.current = result");
    expect(form).toContain("restoredDraft.current = toDraft(result.policy)");
    expect(form).toContain("setDraft(restoredDraft.current)");
    // Never persisted or logged.
    expect(form).not.toMatch(/(?:localStorage|sessionStorage)\./);
    expect(form).not.toMatch(/console\.(?:log|warn|error)\(/);
  });
  it("load() cannot overwrite the restored draft afterwards", () => {
    // setDraft inside load() consults the pending restore; the restore effect
    // must appear before load() and the retry effect must not bypass it.
    expect(form).toContain("setDraft(restoredDraft.current ?? next);");
    expect(form).not.toMatch(/restoredDraft\.current[\s\S]*?setSaved\(restoredDraft/);
    // `saved` always comes from the server settings, so dirty stays accurate.
    const savedCalls = [...form.matchAll(/setSaved\(([^)]+)\)/g)].map((m) => m[1]);
    expect(savedCalls).toEqual(["next", "next"]);
    // Editing after a restore clears the pending restore before a retry.
    expect(form).toContain("restoredDraft.current = null;");
  });
});

describe("restored draft round-trips exactly", () => {
  it("result policy -> toDraft -> toPayload is byte-identical", () => {
    const policy = {
      ssoGroupsClaim: "realm.groups",
      samlAttributeGroups: "memberOf",
      ssoAllowedGroups: ["eng", "ops"],
      ssoAdminGroups: ["admins"],
      ssoDefaultRole: "user",
      ssoGroupWorkspaceMap: [{ group: "eng", workspaceId: "ws-1", role: "manager" }],
    };
    const restored = toDraft(policy);
    expect(toPayload(restored)).toEqual(policy);
    // Dirty logic: a restored draft that differs from saved shows dirty.
    const saved = toDraft({ ssoDefaultRole: "pending" });
    expect(JSON.stringify(toPayload(restored))).not.toBe(JSON.stringify(toPayload(saved)));
  });
});
