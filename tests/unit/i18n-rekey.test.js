import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRenameMap, rekeyLocales } from "../../scripts/i18n-rekey.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function fixture(oldCopy, newCopy) {
  const root = mkdtempSync(join(tmpdir(), "yan409-rekey-"));
  roots.push(root);
  const file = "src/app/(dashboard)/page.js";
  mkdirSync(join(root, "src/app/(dashboard)"), { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, file), oldCopy);
  git(root, "add", ".");
  git(root, "commit", "-qm", "old");
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, file), newCopy);
  git(root, "add", ".");
  git(root, "commit", "-qm", "new");
  return { root, base, head: git(root, "rev-parse", "HEAD") };
}

describe("buildRenameMap", () => {
  it("maps a changed literal at the same source location", () => {
    const { root, base, head } = fixture(
      "<div><button>Back to Providers</button><p>Stable copy</p></div>",
      "<div><button>Back to providers</button><p>Stable copy</p></div>",
    );
    const { mapping, unmapped } = buildRenameMap(
      root,
      base,
      head,
      ["Back to providers"],
      ["Back to Providers"],
    );
    expect(mapping).toEqual({ "Back to Providers": "Back to providers" });
    expect(unmapped).toEqual([]);
  });

  it("stays silent when the new literal sits in a different slot", () => {
    const { root, base, head } = fixture(
      "<div><button>Back to Providers</button></div>",
      "<div><p>Back to providers</p></div>",
    );
    const { mapping, unmapped } = buildRenameMap(
      root,
      base,
      head,
      ["Back to providers"],
      ["Back to Providers"],
    );
    expect(mapping).toEqual({});
    expect(unmapped).toEqual(["Back to providers"]);
  });

  it("pairs repeated identical literals in the same slot", () => {
    const { root, base, head } = fixture(
      "<div><button>Bulk Add</button><button>Bulk Add</button></div>",
      "<div><button>Bulk add</button><button>Bulk add</button></div>",
    );
    const { mapping, unmapped } = buildRenameMap(root, base, head, ["Bulk add"], ["Bulk Add"]);
    expect(mapping).toEqual({ "Bulk Add": "Bulk add" });
    expect(unmapped).toEqual([]);
  });

  it("does not guess when two old literals feed one new literal", () => {
    const { root, base, head } = fixture(
      "<div><button>Start</button><p>Begin</p></div>",
      "<div><button>Launch</button><p>Launch</p></div>",
    );
    const { mapping, unmapped } = buildRenameMap(root, base, head, ["Launch"], ["Start", "Begin"]);
    expect(mapping).toEqual({});
    expect(unmapped).toEqual(["Launch"]);
  });

  it("reports a fork (one old literal feeding two new literals) as unmapped", () => {
    const { root, base, head } = fixture(
      "<div><button>Save All</button><button>Save All</button></div>",
      "<div><button>Save all</button><button>SAVE ALL</button></div>",
    );
    const { mapping, unmapped } = buildRenameMap(
      root,
      base,
      head,
      ["Save all", "SAVE ALL"],
      ["Save All"],
    );
    expect(mapping).toEqual({});
    expect(unmapped.sort()).toEqual(["SAVE ALL", "Save all"]);
  });
});

describe("rekeyLocales", () => {
  it("copies each old value without deleting or overwriting old/new keys", () => {
    const locales = new Map([
      ["de", { "Back to Providers": "Zurück", Stable: "Stable" }],
      ["fr", { "Back to Providers": "Retour", "Back to providers": "Déjà" }],
    ]);
    expect(rekeyLocales(locales, { "Back to Providers": "Back to providers" })).toEqual({
      counts: { de: 1, fr: 0 },
      locales: new Map([
        ["de", { "Back to Providers": "Zurück", Stable: "Stable", "Back to providers": "Zurück" }],
        ["fr", { "Back to Providers": "Retour", "Back to providers": "Déjà" }],
      ]),
    });
  });
});
