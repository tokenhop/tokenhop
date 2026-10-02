// YAN-333: the skill set follows the brand switch; legacy skill links keep working.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEGACY, loadModule, restoreBrand } from "../helpers/cliToolsBrand.js";

const OLD = LEGACY.slug;

const ROOT = path.resolve(import.meta.dirname, "../..");
const load = (brand) => loadModule(brand, "@/shared/constants/skills.js");

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

describe("skills per brand", () => {
  it.each([OLD, "tokenhop"])("%s: every listed skill has its SKILL.md", async (brand) => {
    const { SKILLS, ENTRY_SKILL_ID } = await load(brand);
    expect(ENTRY_SKILL_ID).toBe(brand);
    for (const skill of SKILLS) {
      expect(skill.id.startsWith(brand)).toBe(true);
      const file = fs.readFileSync(path.join(ROOT, "skills", skill.path), "utf8");
      // On the default brand the listed files are pointer stubs, whose name
      // line carries the legacy(9router) marker (YAN-634).
      expect(file).toMatch(new RegExp(`^---\\nname: ${skill.id}(\\n| )`));
    }
  });

  it("tokenhop serves its skills and the legacy ones", async () => {
    const { SKILLS } = await load(OLD);
    const legacyIds = SKILLS.map((skill) => skill.id);
    for (const id of ["tokenhop", "tokenhop-chat", ...legacyIds]) {
      const res = await getSkill("tokenhop", id);
      expect(res.status, id).toBe(200);
    }
    // Legacy ids serve the tokenhop content, not the pointer stubs (YAN-634).
    for (const suffix of ["", "-chat", "-web-search"]) {
      const res = await getSkill("tokenhop", `${OLD}${suffix}`);
      expect(await res.text()).toMatch(new RegExp(`^---\\nname: tokenhop${suffix}\\n`));
    }
  });

  it("the default brand keeps tokenhop skills hidden", async () => {
    expect((await getSkill(OLD, OLD)).status).toBe(200);
    expect((await getSkill(OLD, "tokenhop")).status).toBe(404);
  });
});
