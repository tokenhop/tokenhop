// YAN-373: fresh workspace proof and SSO draft preview boundaries. Request
// bodies are exact, one-shot reads never fall back, redirect schemes validated.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  consumeWorkspaceReauth,
  deleteWorkspace,
  safeAuthorizeUrl,
  startWorkspaceReauth,
} from "@/app/(dashboard)/dashboard/admin/workspaces/[id]/workspaceApi.js";
import {
  fetchSsoPreviewResult,
  previewResultMessage,
  startSsoPreview,
} from "@/app/(dashboard)/dashboard/admin/provisioning/ssoApi.js";
import { toPayload, toDraft } from "@/app/(dashboard)/dashboard/admin/provisioning/policyDraft.js";

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const read = (file) => readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");
afterEach(() => vi.unstubAllGlobals());

describe("workspace fresh-proof API", () => {
  it("sends exactly three password keys with the URL workspace id", async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ deleted: true }));
    vi.stubGlobal("fetch", fetch);
    await deleteWorkspace("ws/1", { currentPassword: "current" });
    expect(fetch.mock.calls[0][0]).toBe("/api/workspaces/ws%2F1");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      confirmWorkspaceId: "ws/1",
      acknowledgeDekDestruction: true,
      currentPassword: "current",
    });
  });
  it("SSO deletion sends proof, never password or confirmation-only fallback", async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ deleted: true }));
    vi.stubGlobal("fetch", fetch);
    await deleteWorkspace("ws", { ssoProof: "opaque", currentPassword: "ignored" });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      confirmWorkspaceId: "ws",
      acknowledgeDekDestruction: true,
      ssoProof: "opaque",
    });
    await consumeWorkspaceReauth("ws");
    await startWorkspaceReauth("ws", "oidc");
    expect(fetch.mock.calls[1][1].method).toBe("GET");
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ provider: "oidc" });
  });
  it("rejects unsafe or missing sign-in URLs", () => {
    expect(safeAuthorizeUrl("https://idp.test/auth")).toBe("https://idp.test/auth");
    for (const url of [undefined, "javascript:alert(1)", "data:text/plain,proof", "/relative"]) {
      expect(safeAuthorizeUrl(url)).toBeNull();
    }
  });
});

describe("fresh draft preview", () => {
  it("sends only provider and the six current unsaved policy keys", async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ authorizeUrl: "https://idp.test/auth" }));
    vi.stubGlobal("fetch", fetch);
    const policy = toPayload(
      toDraft({
        ssoGroupsClaim: "draft.groups",
        ssoAllowedGroups: ["draft-team"],
        ssoDefaultRole: "user",
      }),
    );
    await startSsoPreview("oidc", policy);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(Object.keys(body).sort()).toEqual(["policy", "provider"]);
    expect(Object.keys(body.policy).sort()).toEqual([
      "samlAttributeGroups",
      "ssoAdminGroups",
      "ssoAllowedGroups",
      "ssoDefaultRole",
      "ssoGroupWorkspaceMap",
      "ssoGroupsClaim",
    ]);
    expect(body.policy.ssoGroupsClaim).toBe("draft.groups");
    expect(body.policy.ssoAllowedGroups).toEqual(["draft-team"]);
  });
  it("rejects oversized drafts before a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(startSsoPreview("oidc", { ssoAllowedGroups: ["x".repeat(9000)] })).rejects.toThrow(
      /too large/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("404 result stays absent: no saved-policy fallback", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ code: "not_found", error: "No completed SSO preview" }),
    });
    vi.stubGlobal("fetch", fetch);
    await expect(fetchSsoPreviewResult()).rejects.toMatchObject({ status: 404 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(previewResultMessage({ status: 404 })).toMatch(/No preview result/);
  });
});

describe("failed SSO round trips stop at the callback page", () => {
  it("failed flags show an error and return before the one-shot GET", async () => {
    const { readFile } = await import("node:fs/promises");
    const ws = await readFile(
      new URL("../../src/app/(dashboard)/dashboard/admin/workspaces/[id]/page.js", import.meta.url),
      "utf8",
    );
    const hook = await readFile(
      new URL(
        "../../src/app/(dashboard)/dashboard/admin/provisioning/useSsoPreview.js",
        import.meta.url,
      ),
      "utf8",
    );
    const cases = [
      [ws, "consumeWorkspaceReauth(", /flag !== "1" && flag !== "failed"/],
      [hook, "fetchSsoPreviewResult()", /flag === "1" \|\| flag === "failed"/],
    ];
    for (const [src, getter, guard] of cases) {
      expect(src).toMatch(guard);
      expect(src).toMatch(/if \(flag === "failed"\)/);
      const failedIdx = src.indexOf('if (flag === "failed")');
      const target = src.indexOf(getter);
      expect(target, "GET must follow the failed guard").toBeGreaterThan(failedIdx);
    }
  });
});

describe("UI proof guards", () => {
  it("requires exact typed name, acknowledgment and fresh proof before deletion", () => {
    const s = read("app/(dashboard)/dashboard/admin/workspaces/[id]/DeleteWorkspaceDialog.js");
    expect(s).toContain("typedName === workspace.name");
    expect(s).toContain("nameMatches && acknowledged && hasProof && !busy");
    expect(s).toContain("disabled={!canDelete}");
    expect(s).toMatch(/Old backups together with the master key/);
    expect(s).toMatch(/Usage history is retained/);
    expect(s).toMatch(/other workspaces/);
  });
  it("callback GETs are once-only and secrets stay in memory", () => {
    const ws = read("app/(dashboard)/dashboard/admin/workspaces/[id]/page.js");
    const preview = read("app/(dashboard)/dashboard/admin/provisioning/useSsoPreview.js");
    expect(ws).toContain("reauthDoneRef.current = true");
    expect(preview).toContain("consumed.current = true");
    for (const s of [ws, preview]) {
      expect(s).not.toMatch(/(?:localStorage|sessionStorage)\./);
      expect(s).not.toMatch(/console\.(?:log|warn|error)\(/);
      expect(s).toContain("history.replaceState(null");
    }
  });
});
