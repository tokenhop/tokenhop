import { describe, it, expect } from "vitest";
import { deriveQuotaAccounts } from "@/lib/home/quota.js";

describe("deriveQuotaAccounts", () => {
  it("derives remaining percentage and resetsAt from snapshot windows", () => {
    const connections = [
      { id: "c1", provider: "claude", name: "Claude Work" },
      { id: "c2", provider: "codex", name: "Codex Main" },
      { id: "c3", provider: "openai", name: "OpenAI Direct" },
    ];

    const snapshotMap = {
      c1: {
        provider: "claude",
        windows: [
          { kind: "5h", usedFraction: 0.82, resetsAt: Date.now() + 3600000 },
          { kind: "7d", usedFraction: 0.2, resetsAt: Date.now() + 86400000 },
        ],
      },
      c2: {
        provider: "codex",
        windows: [{ kind: "5h", usedFraction: 0.59, resetsAt: Date.now() + 7200000 }],
      },
    };

    const accounts = deriveQuotaAccounts(connections, (id) => snapshotMap[id]);
    expect(accounts.length).toBe(3);
    expect(accounts[0]).toMatchObject({
      id: "c1",
      provider: "claude",
      name: "Claude Work",
      remaining: 18,
    });
    expect(accounts[1]).toMatchObject({
      id: "c2",
      provider: "codex",
      name: "Codex Main",
      remaining: 41,
    });
    expect(accounts[2]).toMatchObject({
      id: "c3",
      provider: "openai",
      name: "OpenAI Direct",
      remaining: null,
      resetsAt: null,
    });
  });

  it("handles empty connections and missing snapshots gracefully", () => {
    expect(deriveQuotaAccounts([], () => null)).toEqual([]);
    expect(deriveQuotaAccounts(null, () => null)).toEqual([]);
  });
});
