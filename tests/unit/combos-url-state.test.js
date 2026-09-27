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

  it("preserves other params, hash, and history state; skips redundant writes", () => {
    const location = { href: "https://example.test/dashboard/combos?tab=details&create=1#editor" };
    Object.defineProperty(location, "search", {
      get: () => new URL(location.href).search,
    });
    const calls = [];
    const state = { navigation: 42 };
    const history = {
      state,
      pushState: (...args) => {
        calls.push(["push", ...args]);
        location.href = new URL(args[2], location.href).href;
      },
      replaceState: (...args) => {
        calls.push(["replace", ...args]);
        location.href = new URL(args[2], location.href).href;
      },
    };
    const setUrlParam = new Function(
      "window",
      `${source.match(/function setUrlParam\([\s\S]*?\n}/)[0]}; return setUrlParam;`,
    )({ location, history });
    setUrlParam("combo", "foo/bar", "pushState");
    expect(calls[0]).toEqual([
      "push",
      state,
      "",
      "/dashboard/combos?tab=details&create=1&combo=foo%2Fbar#editor",
    ]);
    setUrlParam("combo", "foo/bar", "pushState");
    expect(calls).toHaveLength(1);
    setUrlParam("create", null);
    expect(calls[1][0]).toBe("replace");
    expect(location.href).toBe(
      "https://example.test/dashboard/combos?tab=details&combo=foo%2Fbar#editor",
    );
  });
});
