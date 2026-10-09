// YAN-376: collection resource requests carry the active workspace while
// multi-user scope exists; null scope keeps the legacy URLs.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { withWorkspace } from "@/app/(dashboard)/dashboard/providers/connectTarget";

const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

it("adds only an explicit active workspace", () => {
  expect(withWorkspace("/api/models/alias", null)).toBe("/api/models/alias");
  expect(withWorkspace("/api/models/alias", "w 1")).toBe("/api/models/alias?workspaceId=w%201");
});

it("scopes every combos and model collection caller", () => {
  const callers = {
    "src/app/(dashboard)/dashboard/combos/CombosPageClient.js": [
      "/api/combos",
      "/api/models/alias",
    ],
    "src/shared/components/ComboFormModal.js": ["/api/models/alias"],
    "src/app/(dashboard)/dashboard/providers/components/ProviderDetailSidePanel.js": [
      "/api/models/custom",
      "/api/models/alias",
    ],
    "src/app/(dashboard)/dashboard/media-providers/components/MediaKindSection.js": ["/api/combos"],
    "src/app/(dashboard)/dashboard/media-providers/combo/[id]/useMediaCombo.js": [
      "/api/models/alias",
    ],
    "src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/SttExampleCard.js": [
      "/api/models/custom",
    ],
    "src/app/(dashboard)/dashboard/cli-tools/hooks/useToolSetupData.js": ["/api/models/alias"],
    "src/app/(dashboard)/dashboard/cli-tools/components/CoworkToolCard.js": ["/api/combos"],
    "src/shared/components/CommandPaletteProvider.js": ["/api/combos"],
  };
  for (const [file, urls] of Object.entries(callers)) {
    const text = source(file);
    for (const url of urls) {
      expect(text).toContain(`withWorkspace("${url}"`);
      expect(text).not.toContain(`fetch("${url}"`);
    }
  }
  const models = source("src/app/(dashboard)/dashboard/providers/detail/useModels.js");
  expect(models).toContain("/^\\/api\\/models\\/(alias|custom|disabled)(\\?|$)/");
  expect(models).toContain("withWorkspace(url, scope?.workspaceId)");
});
