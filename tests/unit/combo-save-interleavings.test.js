import { describe, expect, it, vi } from "vitest";
import {
  saveComboRoute,
  shouldReseedDraft,
  commitModelsIntoList,
  shouldGuardLinkClick,
} from "../../src/shared/components/combos/comboSave.js";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const snapshot = { models: ["p/new"], strategy: "weighted", weights: { "p/new": 2 }, judge: "" };

describe("ordered save", () => {
  it("commits models before strategy; failed PATCH leaves models truthful and strategy dirty", async () => {
    const patch = deferred();
    const commits = [];
    const saved = [];
    const saving = saveComboRoute({
      putModels: async () => ({ id: "a", name: "A", models: snapshot.models }),
      patchStrategy: () => patch.promise,
      onModelsCommitted: (combo) => commits.push(combo),
      onSaved: (commit) => saved.push(commit),
    });
    await vi.waitFor(() => expect(commits).toEqual([{ id: "a", name: "A", models: ["p/new"] }]));
    expect(saved).toEqual([]);
    patch.reject(new Error("strategy rejected"));
    await expect(saving).rejects.toThrow("strategy rejected");
    expect(saved).toEqual([]);
  });

  it("PUT model failure rejects before strategy ever runs; committed list untouched", async () => {
    const strategy = vi.fn();
    const committed = vi.fn();
    await expect(
      saveComboRoute({
        putModels: async () => {
          throw new Error("PUT down");
        },
        patchStrategy: strategy,
        onModelsCommitted: committed,
        onSaved: vi.fn(),
      }),
    ).rejects.toThrow("PUT down");
    expect(strategy).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
  });

  it("commits models keyed by combo id; late A list update cannot touch B row", () => {
    let prev = [
      { id: "a", models: ["p/old"] },
      { id: "b", models: ["p/b"] },
    ];
    const setter = (fn) => {
      prev = fn(prev);
    };
    commitModelsIntoList({ id: "a", models: ["p/new"] }, setter);
    expect(prev).toEqual([
      { id: "a", models: ["p/new"] },
      { id: "b", models: ["p/b"] },
    ]);
    commitModelsIntoList({ models: ["p/orphan"] }, setter);
    expect(prev).toEqual([
      { id: "a", models: ["p/new"] },
      { id: "b", models: ["p/b"] },
    ]);
  });

  it("late save of A cannot reseed B or overwrite newer edits of A", async () => {
    const patch = deferred();
    let currentId = "a";
    let generation = 4;
    const reseeds = [];
    const saving = saveComboRoute({
      putModels: async () => ({ id: "a", models: snapshot.models }),
      patchStrategy: () => patch.promise,
      onModelsCommitted: vi.fn(),
      onSaved: () => {
        if (shouldReseedDraft("a", 4, currentId, generation)) reseeds.push("a");
      },
    });
    currentId = "b";
    patch.resolve();
    await saving;
    expect(reseeds).toEqual([]);
    currentId = "a";
    generation = 5;
    expect(shouldReseedDraft("a", 4, currentId, generation)).toBe(false);
    expect(shouldReseedDraft("a", 5, currentId, generation)).toBe(true);
    expect(shouldReseedDraft("b", 5, currentId, generation)).toBe(false);
  });
});

describe("link interception decision", () => {
  const origin = "http://localhost:20128";
  const here = `${origin}/dashboard/combos?combo=a`;
  it("guards same-origin different URL only", () => {
    const left = { button: 0 };
    expect(shouldGuardLinkClick(left, { href: `${origin}/dashboard` }, here, origin)).toBe(true);
    expect(shouldGuardLinkClick(left, { href: here }, here, origin)).toBe(false);
    expect(shouldGuardLinkClick(left, { href: "https://example.com/x" }, here, origin)).toBe(false);
    expect(shouldGuardLinkClick(left, { href: `${here}#editor` }, here, origin)).toBe(false);
  });
  it("skips modifiers, non-left button, _blank and download", () => {
    const link = { href: `${origin}/dashboard` };
    expect(shouldGuardLinkClick({ button: 0, metaKey: true }, link, here, origin)).toBe(false);
    expect(shouldGuardLinkClick({ button: 2 }, link, here, origin)).toBe(false);
    expect(shouldGuardLinkClick({ button: 0 }, { ...link, target: "_blank" }, here, origin)).toBe(
      false,
    );
    expect(shouldGuardLinkClick({ button: 0 }, { ...link, hasDownload: true }, here, origin)).toBe(
      false,
    );
  });
});
