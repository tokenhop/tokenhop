// YAN-634: the legacy skills are pointer stubs to the tokenhop skills; the
// gateway serves the tokenhop content under the legacy ids on both brands.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEGACY, loadModule, restoreBrand } from "../helpers/cliToolsBrand.js";

const OLD = LEGACY.slug;
const ROOT = path.resolve(import.meta.dirname, "../..");
const RAW_BASE = "https://raw.githubusercontent.com/tokenhop/tokenhop/refs/heads/master/skills";
const SUFFIXES = [
  "",
  "-chat",
  "-image",
  "-video",
  "-tts",
  "-stt",
  "-embeddings",
  "-web-search",
  "-web-fetch",
];

const STUB = (oldId, newId) => `---
name: ${oldId} # legacy(9router): remove in v2
description: This skill moved to ${newId}. Fetch ${RAW_BASE}/${newId}/SKILL.md and use it instead.
---

This skill moved. Fetch the current version:

<${RAW_BASE}/${newId}/SKILL.md>
`;

async function getSkill(brand, id) {
  vi.spyOn(process, "cwd").mockReturnValue(ROOT);
  const { GET } = await loadModule(brand, "@/app/skills/[...slug]/route.js");
  return GET(new Request(`http://localhost/skills/${id}/SKILL.md`), {
    params: Promise.resolve({ slug: [id, "SKILL.md"] }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  restoreBrand();
});

describe("legacy skill stubs", () => {
  it.each(SUFFIXES)("legacy skill%s is a pure pointer to an existing tokenhop skill", (suffix) => {
    const file = path.join(ROOT, "skills", `${OLD}${suffix}`, "SKILL.md");
    expect(fs.readFileSync(file, "utf8")).toBe(STUB(`${OLD}${suffix}`, `tokenhop${suffix}`));
    // The stub's URL points at a real file in the repo.
    expect(fs.existsSync(path.join(ROOT, "skills", `tokenhop${suffix}`, "SKILL.md"))).toBe(true);
  });

  it.each(SUFFIXES)(
    "every brand serves the tokenhop content at the legacy skill%s id",
    async (suffix) => {
      const id = `${OLD}${suffix}`;
      const tokenhop = fs.readFileSync(
        path.join(ROOT, "skills", `tokenhop${suffix}`, "SKILL.md"),
        "utf8",
      );
      for (const brand of [OLD, "tokenhop"]) {
        const res = await getSkill(brand, id);
        expect(res.status, `${brand} ${id}`).toBe(200);
        expect(await res.text(), `${brand} ${id}`).toBe(tokenhop);
      }
    },
  );

  it("the default brand keeps tokenhop ids hidden", async () => {
    expect((await getSkill(OLD, "tokenhop")).status).toBe(404);
    expect((await getSkill(OLD, "tokenhop-chat")).status).toBe(404);
  });
});
