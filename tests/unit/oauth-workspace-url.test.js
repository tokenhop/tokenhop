import { describe, it, expect } from "vitest";

import { withOAuthWorkspace } from "@/shared/utils/oauthWorkspace.js";

describe("withOAuthWorkspace", () => {
  it("returns the original URL when no workspace is given", () => {
    expect(withOAuthWorkspace("/api/oauth/codex/poll")).toBe("/api/oauth/codex/poll");
    expect(withOAuthWorkspace("/api/oauth/codex/poll", null)).toBe("/api/oauth/codex/poll");
    expect(withOAuthWorkspace("/api/oauth/x/authorize?a=1", null)).toBe(
      "/api/oauth/x/authorize?a=1",
    );
  });

  it("appends an encoded workspaceId", () => {
    expect(withOAuthWorkspace("/api/oauth/codex/poll", "ws 1&x=y")).toBe(
      "/api/oauth/codex/poll?workspaceId=ws%201%26x%3Dy",
    );
  });

  it("preserves an existing query string", () => {
    expect(withOAuthWorkspace("/api/oauth/x/poll-status?state=a%20b", "w1")).toBe(
      "/api/oauth/x/poll-status?state=a%20b&workspaceId=w1",
    );
  });

  it("works with absolute URLs", () => {
    expect(withOAuthWorkspace("http://localhost:1/api/oauth/x/authorize?r=1", "w1")).toBe(
      "http://localhost:1/api/oauth/x/authorize?r=1&workspaceId=w1",
    );
  });
});
