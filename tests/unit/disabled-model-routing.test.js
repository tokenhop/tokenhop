// YAN-661: a model disabled on the provider page must not be routed, and a
// combo must skip it.
import { describe, it, expect } from "vitest";

import { updateSettings } from "../../src/lib/localDb.js";
import { disableModels } from "../../src/lib/disabledModelsDb.js";
import { handleChat } from "../../src/sse/handlers/chat.js";
import { getProviderAlias } from "../../src/shared/constants/providers.js";

const chat = (model) =>
  handleChat(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    }),
  );

describe("disabled models (YAN-661)", () => {
  it("returns 404 for a disabled model instead of routing it upstream", async () => {
    await updateSettings({ requireApiKey: false });
    const alias = getProviderAlias("openai");
    await disableModels(alias, ["gpt-4o-mini"]);

    const res = await chat(`${alias}/gpt-4o-mini`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toContain("Model disabled");
  });
});
