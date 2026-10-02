// YAN-683: /v1/models must keep the token limits a live catalog reports
// instead of downgrading them to the generic pattern table (grok-build was
// reported as 256k from the *grok* pattern while the live catalog says 500k).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("open-sse/services/grokCliModels.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveGrokCliModels: vi.fn(async () => ({
    models: [
      { id: "grok-build", name: "Grok Build", contextLength: 500000, maxOutputTokens: 64000 },
    ],
  })),
}));

import { buildModelsList } from "@/app/api/v1/models/route.js";
import { createProviderConnection, deleteProviderConnectionsByProvider } from "@/models/index.js";
import { clearLiveModelsCache } from "@/lib/providerModels/liveResolvers.js";
import { getProviderAlias } from "@/shared/constants/providers";

beforeEach(async () => {
  clearLiveModelsCache();
  await deleteProviderConnectionsByProvider("grok-cli");
});

describe("/v1/models live catalog limits (YAN-683)", () => {
  it("reports the live catalog's context and output limits", async () => {
    await createProviderConnection({
      provider: "grok-cli",
      authType: "oauth",
      accessToken: "at-grok",
      testStatus: "active",
    });
    const alias = getProviderAlias("grok-cli");
    const model = (await buildModelsList(["llm"])).find((m) => m.id === `${alias}/grok-build`);
    expect(model).toBeTruthy();
    expect(JSON.stringify(model)).toContain("500000");
    expect(JSON.stringify(model)).toContain("64000");
  });
});
