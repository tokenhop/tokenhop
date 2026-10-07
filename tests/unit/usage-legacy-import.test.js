// YAN-370: the lowdb usage.json import resolves raw keys to ids (never stored)
// and keeps dailySummary totals beyond the trimmed history as rollup residuals.
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
it("legacy usage.json import: ids not raws, residual kept", async () => {
  const { DATA_DIR } = await import("@/lib/dataDir.js");
  const { LEGACY_FILES } = await import("@/lib/db/paths.js");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const RAW = "sk-legacyrawkey-000000000000000000";
  fs.writeFileSync(
    LEGACY_FILES.main,
    JSON.stringify({
      apiKeys: [{ id: "k1", key: RAW, name: "K", createdAt: "2026-01-01T00:00:00Z" }],
    }),
  );
  fs.writeFileSync(
    LEGACY_FILES.usage,
    JSON.stringify({
      history: [
        {
          timestamp: "2026-01-02T12:00:00Z",
          provider: "openai",
          model: "gpt-4o",
          apiKey: RAW,
          tokens: { prompt_tokens: 1 },
        },
      ],
      dailySummary: {
        "2026-01-02": {
          byModel: { "gpt-4o|openai": { requests: 5, rawModel: "gpt-4o", provider: "openai" } },
        },
      },
    }),
  );
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  const all = JSON.stringify([
    db.all("SELECT * FROM usageHistory"),
    db.all("SELECT * FROM usageRollup"),
  ]);
  expect(all).not.toContain(RAW);
  expect(db.get("SELECT apiKey, apiKeyId FROM usageHistory")).toEqual({
    apiKey: null,
    apiKeyId: "k1",
  });
  expect(db.get("SELECT SUM(requests) AS n FROM usageRollup").n).toBe(5);
  expect(db.get("SELECT 1 AS x FROM sqlite_master WHERE name='usageDaily'")).toBeUndefined();
});
