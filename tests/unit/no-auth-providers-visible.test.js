// YAN-684: hidden no-auth providers (dead services like mimo-free, devin-cli)
// must never reach the usage topology or model picker, which both source their
// always-on no-auth list from VISIBLE_NO_AUTH_PROVIDERS.
import { describe, it, expect } from "vitest";
import { FREE_PROVIDERS, VISIBLE_NO_AUTH_PROVIDERS } from "@/shared/constants/providers";

describe("VISIBLE_NO_AUTH_PROVIDERS", () => {
  it("drops hidden no-auth providers but keeps visible ones", () => {
    const ids = VISIBLE_NO_AUTH_PROVIDERS.map((p) => p.id);

    // Every entry must be a free no-auth provider that is not hidden.
    for (const p of VISIBLE_NO_AUTH_PROVIDERS) {
      expect(FREE_PROVIDERS[p.id]?.noAuth).toBe(true);
      expect(FREE_PROVIDERS[p.id]?.hidden).toBeFalsy();
    }

    // Hidden services stay hidden.
    expect(ids).not.toContain("mimo-free");
    expect(ids).not.toContain("devin-cli");
    // A live no-auth provider is still offered.
    expect(ids).toContain("opencode");
  });
});
