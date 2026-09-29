import { describe, expect, it } from "vitest";
import { partitionMediaProviders } from "@/app/(dashboard)/dashboard/media-providers/components/mediaProviderSections.js";

describe("partitionMediaProviders", () => {
  const providers = [
    { id: "alpha", name: "Alpha" },
    { id: "bravo", name: "Bravo" },
    { id: "custom-embedding", name: "Custom embedding", isCustom: true },
    { id: "charlie", name: "Charlie" },
  ];

  it("puts providers with any stored connection first, including disabled and auth-error", () => {
    const { connected, others } = partitionMediaProviders(providers, [
      { provider: "bravo", isActive: false },
      { provider: "custom-embedding", testStatus: "error" },
    ]);
    expect(connected.map(({ id }) => id)).toEqual(["bravo", "custom-embedding"]);
    expect(others.map(({ id }) => id)).toEqual(["alpha", "charlie"]);
    // Input and per-group source order stay untouched.
    expect(providers.map(({ id }) => id)).toEqual([
      "alpha",
      "bravo",
      "custom-embedding",
      "charlie",
    ]);
  });

  it("returns one catalog group when nothing is connected (including no-auth providers)", () => {
    const result = partitionMediaProviders(providers, []);
    expect(result.connected).toEqual([]);
    expect(result.others).toEqual(providers);
  });

  it("handles repeated and unrelated connections without duplicating cards", () => {
    const { connected, others } = partitionMediaProviders(providers, [
      { provider: "bravo" },
      { provider: "bravo" },
      { provider: "unknown" },
      { provider: "alpha" },
    ]);
    expect(connected.map(({ id }) => id)).toEqual(["alpha", "bravo"]);
    expect(others.map(({ id }) => id)).toEqual(["custom-embedding", "charlie"]);
  });
});
