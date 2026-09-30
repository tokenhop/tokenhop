import { describe, expect, it } from "vitest";
import {
  buildProviderSections,
  isYourProvider,
} from "@/app/(dashboard)/dashboard/providers/providerSections.js";
import { LIST_FILTERS } from "@/app/(dashboard)/dashboard/providers/utils.js";

const conn = (id, provider, authType, fields = {}) => ({
  id,
  provider,
  authType,
  isActive: true,
  testStatus: "active",
  ...fields,
});

const connections = [
  conn("c1", "claude", "oauth"),
  conn("c2", "codex", "access_token", { testStatus: "error", lastError: "Token invalid" }),
  conn("c3", "openai", "apikey", { isActive: false }),
];

const build = (over = {}) => buildProviderSections({ connections, providerNodes: [], ...over });
const ids = (entries) => entries.map((e) => e.id);

describe("buildProviderSections", () => {
  it("pins every provider with an account, attention first then by name", () => {
    const { yourProviders } = build();
    // codex needs a look; claude and openai (disabled) follow by name.
    expect(ids(yourProviders)).toEqual(["codex", "claude", "openai"]);
  });

  it("keeps pinned providers out of the catalog and no-auth providers in it", () => {
    const { catalogSections, allEntries } = build();
    const catalogIds = catalogSections.flatMap((s) => ids(s.entries));
    for (const id of ["claude", "codex", "openai"]) expect(catalogIds).not.toContain(id);
    const noAuth = allEntries.find((e) => e.isNoAuth);
    expect(isYourProvider(noAuth)).toBe(false);
    expect(catalogIds).toContain(noAuth.id);
  });

  it("pins a stored provider that is missing from the registry", () => {
    const list = [conn("o", "retired-provider", "apikey")];
    expect(ids(build({ connections: list }).yourProviders)).toEqual(["retired-provider"]);
  });

  it("applies search and filter to both pinned and catalog entries", () => {
    const search = build({ query: "CLAUDE" });
    expect(ids(search.yourProviders)).toEqual(["claude"]);
    expect(search.catalogSections.flatMap((s) => ids(s.entries))).not.toContain("codex");

    const attention = build({ filter: LIST_FILTERS.NEEDS_ATTENTION });
    expect(ids(attention.yourProviders)).toEqual(["codex"]);
    expect(attention.catalogSections.every((s) => s.id === "custom")).toBe(true);
  });

  it("keeps an empty custom group for the endpoint card and counts totals", () => {
    const { catalogSections, yourProvidersTotal, totals } = build({ query: "zzz-none" });
    expect(ids(catalogSections)).toEqual(["custom"]);
    expect(yourProvidersTotal).toBe(3);
    expect(totals.connected).toBe(2);
    expect(totals.attention).toBe(1);
  });

  it("lists unconnected custom nodes in the custom group", () => {
    const providerNodes = [{ id: "openai-compatible-x", type: "openai-compatible", name: "Local" }];
    const { catalogSections, yourProviders } = build({ providerNodes });
    const custom = catalogSections.find((s) => s.id === "custom");
    expect(ids(custom.entries)).toEqual(["openai-compatible-x"]);
    expect(ids(yourProviders)).not.toContain("openai-compatible-x");
  });

  it("shows no pinned providers when nothing is connected", () => {
    const { yourProviders, yourProvidersTotal } = build({ connections: [] });
    expect(yourProviders).toEqual([]);
    expect(yourProvidersTotal).toBe(0);
  });
});
