import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../src/app/(dashboard)/dashboard/combos/CombosPageClient.js", import.meta.url),
  "utf8",
);

// The page contains JSX in a .js file, so exercise the small URL helpers in
// isolation without pulling its React component into the Node test runner.
function loadHelper(name) {
  const match = source.match(new RegExp(`(?:export )?function ${name}\\([\\s\\S]*?\\n}`));
  if (!match) throw new Error(`Missing ${name}`);
  return new Function("window", `${match[0].replace(/^export /, "")}; return ${name};`)(
    globalThis.window,
  );
}

describe("combo URL state", () => {
  it("reads combo and create params independently", () => {
    const readComboSelection = loadHelper("readComboSelection");
    const readCreateRequested = loadHelper("readCreateRequested");
    expect(readComboSelection("?tab=details&combo=foo%2Fbar&create=1")).toBe("foo/bar");
    expect(readComboSelection("?create=1")).toBeNull();
    expect(readCreateRequested("?create=1")).toBe(true);
    expect(readCreateRequested("?create=0")).toBe(false);
  });

  it("applies same-route query changes to an already selected combo", () => {
    const readComboSelection = loadHelper("readComboSelection");
    const readCreateRequested = loadHelper("readCreateRequested");
    const resolveComboSelection = loadHelper("resolveComboSelection");
    const list = [{ id: "first" }, { id: "second" }];
    expect(resolveComboSelection(readComboSelection("?combo=second"), list, "first")).toBe(
      "second",
    );
    expect(resolveComboSelection(readComboSelection("?combo=first"), list, "second")).toBe("first");
    expect(resolveComboSelection("missing", list, "second")).toBe("second");
    expect(resolveComboSelection("missing", list, null)).toBe("first");
    expect(resolveComboSelection(null, [], "first")).toBeNull();
    expect(readCreateRequested("?create=1")).toBe(true);
    expect(readCreateRequested("?combo=second")).toBe(false);
  });

  it("preserves other params and the hash when navigating", () => {
    const comboHref = loadHelper("comboHref");
    expect(comboHref("?tab=details&create=1#editor", { combo: "foo/bar" })).toBe(
      "/dashboard/combos?tab=details&create=1&combo=foo%2Fbar#editor",
    );
    expect(comboHref("?combo=foo%2Fbar&tab=details", { combo: null })).toBe(
      "/dashboard/combos?tab=details",
    );
    expect(comboHref("", { combo: "first" })).toBe("/dashboard/combos?combo=first");
    expect(comboHref("?combo=old&create=1", { combo: "new", create: false })).toBe(
      "/dashboard/combos?combo=new",
    );
  });
});
