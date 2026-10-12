// YAN-373: rendered admin guard states via the real Vite SSR harness. Mocks
// control /api/auth/status; the guard never authorizes locally.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createSsr } from "../helpers/renderSsr.js";

const AUTH = {
  multiUserActive: true,
  principal: {
    user: { id: "u", email: "a@x.test" },
    role: "owner",
    workspaces: [{ id: "w", role: "owner", name: "W", kind: "shared" }],
    activeWorkspaceId: "w",
  },
};

describe("AdminGuard render (YAN-373)", () => {
  let ssr;
  beforeAll(async () => {
    ssr = await createSsr();
  });
  afterAll(async () => {
    delete globalThis.__authStatus;
    await ssr.close();
  });
  beforeEach(() => {
    globalThis.__authStatus = AUTH;
    globalThis.__authLoaded = true;
  });

  it("stale client-side multiUser state never blocks the server read", async () => {
    // A fresh one-user install still renders the data view; 404 is caught later.
    // SSR renders useState initial values, so AdminGuard needs no auth state.
    globalThis.__authStatus = { multiUserActive: false };
    const mod = await ssr.load("/src/app/(dashboard)/dashboard/admin/components/AdminShared.js");
    const html = renderToStaticMarkup(
      createElement(mod.AdminGuard, { loadState: null }, createElement("b", null, "content")),
    );
    expect(html).toContain("content");
  });

  it("403 renders the denied state, 500 renders the error view", async () => {
    const mod = await ssr.load("/src/app/(dashboard)/dashboard/admin/components/AdminShared.js");
    const denied = renderToStaticMarkup(
      createElement(mod.AdminGuard, { loadState: "denied" }, createElement("b", null, "content")),
    );
    expect(denied).toContain("No access");
    const errored = renderToStaticMarkup(
      createElement(
        mod.AdminGuard,
        { loadState: "error", error: "boom" },
        createElement("b", null, "content"),
      ),
    );
    expect(errored).toContain("Could not load this view");
    expect(errored).toContain("boom");
  });

  it("a detail 404 renders a resource-gone state with a way back, never switch-off copy", async () => {
    const mod = await ssr.load("/src/app/(dashboard)/dashboard/admin/components/AdminShared.js");
    const gone = {
      icon: "person",
      title: "This user no longer exists",
      body: "The account may have been deleted.",
      action: createElement("a", { href: "/dashboard/admin/users" }, "Back to users"),
    };
    const html = renderToStaticMarkup(
      createElement(
        mod.AdminGuard,
        { loadState: "gone", gone },
        createElement("b", null, "content"),
      ),
    );
    expect(html).toContain("This user no longer exists");
    expect(html).toContain('href="/dashboard/admin/users"');
    expect(html).not.toContain("switched off");
    expect(html).not.toContain("content");
  });

  it("active admin passes through to children", async () => {
    const mod = await ssr.load("/src/app/(dashboard)/dashboard/admin/components/AdminShared.js");
    const html = renderToStaticMarkup(
      createElement(mod.AdminGuard, { loadState: null }, createElement("b", null, "content")),
    );
    expect(html).toContain("content");
  });
});
