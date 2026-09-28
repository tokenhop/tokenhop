import { describe, expect, it } from "vitest";
import { getAvailableSkillBases, getHostedSkillUrl } from "../../src/shared/constants/skills.js";

describe("skill URLs", () => {
  it("uses the selected base and normalizes trailing slashes without dropping a path prefix", () => {
    expect(getHostedSkillUrl("http://localhost:20152/", "9router")).toBe(
      "http://localhost:20152/skills/9router/SKILL.md",
    );
    expect(getHostedSkillUrl("https://r123.abc-tunnel.us///", "9router-web-search")).toBe(
      "https://r123.abc-tunnel.us/skills/9router-web-search/SKILL.md",
    );
    expect(getHostedSkillUrl("https://tail.example.ts.net/", "9router-chat")).toBe(
      "https://tail.example.ts.net/skills/9router-chat/SKILL.md",
    );
  });

  it("rejects malformed bases and unknown skill ids", () => {
    expect(() => getHostedSkillUrl("javascript:alert(1)", "9router")).toThrow();
    expect(() => getHostedSkillUrl("https://host.invalid/path", "9router")).toThrow();
    expect(() => getHostedSkillUrl("https://host.invalid", "../etc/passwd")).toThrow();
  });

  it("only offers active bases with real URLs; prefers tunnel public URL", () => {
    expect(
      getAvailableSkillBases("http://localhost:20152", {
        tunnel: {
          enabled: true,
          publicUrl: "https://r123.abc-tunnel.us/",
          tunnelUrl: "https://internal.trycloudflare.com/",
        },
        tailscale: { settingsEnabled: true, tunnelUrl: "https://tail.example.ts.net" },
      }),
    ).toEqual([
      { value: "local", label: "Local", url: "http://localhost:20152" },
      { value: "tunnel", label: "Tunnel", url: "https://r123.abc-tunnel.us" },
      { value: "tailscale", label: "Tailscale", url: "https://tail.example.ts.net" },
    ]);
    expect(
      getAvailableSkillBases("http://localhost:20152", {
        tunnel: { settingsEnabled: true, tunnelUrl: "" },
        tailscale: { enabled: false, tunnelUrl: "https://tail.example.ts.net" },
      }),
    ).toHaveLength(1);
  });

  it("covers the video skill and tolerates a bad local origin", () => {
    expect(getHostedSkillUrl("http://localhost:20152", "9router-video")).toBe(
      "http://localhost:20152/skills/9router-video/SKILL.md",
    );
    expect(getAvailableSkillBases("", {})[0]).toEqual({
      value: "local",
      label: "Local",
      url: "",
    });
  });
});
