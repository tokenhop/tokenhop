import { describe, it, expect } from "vitest";
import {
  collectCommands,
  fuzzyScore,
  filterAndRank,
  groupResults,
  pushRecent,
  loadRecents,
  saveRecents,
  formatResultAnnouncement,
  shouldOpenCommandPalette,
  COMMAND_GROUPS,
} from "@/shared/utils/commandPalette.js";
import { __test } from "@/shared/utils/commandSources.js";

function cmd(overrides) {
  return {
    id: "x",
    group: "Pages",
    label: "Providers",
    hint: "",
    keywords: "",
    run: () => {},
    ...overrides,
  };
}

describe("fuzzyScore", () => {
  it("empty query matches everything with a neutral score", () => {
    expect(fuzzyScore("", "Providers")).toEqual({ matched: true, score: 0 });
  });

  it("prefix beats word-start beats subsequence", () => {
    const prefix = fuzzyScore("prov", "Providers");
    const wordStart = fuzzyScore("prov", "AI Providers list");
    const subseq = fuzzyScore("prov", "Personal router values");
    expect(prefix.matched).toBe(true);
    expect(wordStart.matched).toBe(true);
    expect(subseq.matched).toBe(true);
    expect(prefix.score).toBeGreaterThan(wordStart.score);
    expect(wordStart.score).toBeGreaterThan(subseq.score);
  });

  it("is case-insensitive and returns no match for missing letters", () => {
    expect(fuzzyScore("PROV", "providers").matched).toBe(true);
    expect(fuzzyScore("zzz", "Providers").matched).toBe(false);
  });

  it("matches against keywords when the label misses", () => {
    const hit = fuzzyScore("oauth", cmd({ label: "Gemini CLI", keywords: "oauth login cli" }));
    expect(hit.matched).toBe(true);
  });
});

describe("filterAndRank", () => {
  const commands = [
    cmd({ id: "a", group: "Pages", label: "Providers" }),
    cmd({ id: "b", group: "Providers", label: "Personal router values" }),
    cmd({ id: "c", group: "Actions", label: "Copy endpoint URL" }),
  ];

  it("ranks prefix matches first and drops non-matches", () => {
    const ranked = filterAndRank(commands, "prov", []);
    expect(ranked.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("breaks score ties by recency, most recent first", () => {
    const tied = [
      cmd({ id: "a", group: "Pages", label: "Usage" }),
      cmd({ id: "b", group: "Pages", label: "Usage" }),
    ];
    expect(filterAndRank(tied, "usage", ["b", "a"]).map((c) => c.id)).toEqual(["b", "a"]);
    expect(filterAndRank(tied, "usage", []).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("empty query returns every command in group then label order", () => {
    const ranked = filterAndRank(commands, "", []);
    expect(ranked.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});

describe("groupResults", () => {
  it("groups in canonical order with counts", () => {
    const ranked = [
      cmd({ id: "c", group: "Actions", label: "Copy endpoint URL" }),
      cmd({ id: "a", group: "Pages", label: "Providers" }),
      cmd({ id: "b", group: "Providers", label: "OpenAI" }),
    ];
    const groups = groupResults(ranked);
    expect(groups.map((g) => g.group)).toEqual(["Pages", "Providers", "Actions"]);
    expect(groups.map((g) => g.count)).toEqual([1, 1, 1]);
    expect(COMMAND_GROUPS).toContain("Pages");
  });
});

describe("pushRecent / loadRecents / saveRecents", () => {
  it("dedupes, unshifts and caps", () => {
    expect(pushRecent(["a", "b"], "c", 3)).toEqual(["c", "a", "b"]);
    expect(pushRecent(["a", "b"], "a", 3)).toEqual(["a", "b"]);
    expect(pushRecent(["a", "b"], "c", 2)).toEqual(["c", "a"]);
  });

  it("tolerates broken storage", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadRecents(throwing)).toEqual([]);
    expect(() => saveRecents(throwing, ["a"])).not.toThrow();
  });

  it("round-trips through storage", () => {
    const store = {};
    const storage = {
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => {
        store[k] = String(v);
      },
    };
    saveRecents(storage, ["a", "b"]);
    expect(loadRecents(storage)).toEqual(["a", "b"]);
  });
});

describe("formatResultAnnouncement", () => {
  it("announces counts and the empty state", () => {
    expect(formatResultAnnouncement(0, [])).toBe("No matches");
    expect(formatResultAnnouncement(3, [{ group: "Pages", count: 2 }])).toMatch(/3 results/);
  });
});

describe("shouldOpenCommandPalette", () => {
  const base = {
    key: "k",
    metaKey: false,
    ctrlKey: true,
    defaultPrevented: false,
    isComposing: false,
    inEditable: false,
    inCodeEditor: false,
  };

  it("opens on Ctrl+K and Cmd+K", () => {
    expect(shouldOpenCommandPalette(base)).toBe(true);
    expect(shouldOpenCommandPalette({ ...base, metaKey: true, ctrlKey: false })).toBe(true);
  });

  it("ignores other keys and lone modifiers", () => {
    expect(shouldOpenCommandPalette({ ...base, key: "j" })).toBe(false);
    expect(shouldOpenCommandPalette({ ...base, ctrlKey: false })).toBe(false);
  });

  it("never hijacks handled, composing, editable or editor contexts", () => {
    expect(shouldOpenCommandPalette({ ...base, defaultPrevented: true })).toBe(false);
    expect(shouldOpenCommandPalette({ ...base, isComposing: true })).toBe(false);
    expect(shouldOpenCommandPalette({ ...base, inEditable: true })).toBe(false);
    expect(shouldOpenCommandPalette({ ...base, inCodeEditor: true })).toBe(false);
  });
});

describe("commandSources deduplication & shapes", () => {
  it("dedupes identical model ids from overlapping catalog and aliases", () => {
    const list = [
      { fullModel: "gemini/gemini-2.5-flash", provider: "gemini", model: "gemini-2.5-flash" },
      { fullModel: "gemini/gemini-2.5-flash", provider: "gemini", model: "gemini-2.5-flash" },
      { id: "openai/gpt-4o", provider: "openai" },
    ];
    const cmds = __test.modelCommands({ models: list });
    expect(cmds.map((c) => c.id)).toEqual(["model:gemini/gemini-2.5-flash", "model:openai/gpt-4o"]);
    expect(cmds[0].run).toEqual({ type: "copy", value: "gemini/gemini-2.5-flash" });
    expect(cmds[0].secondary).toEqual({
      label: "Open provider",
      run: { type: "navigate", href: "/dashboard/providers/gemini" },
    });
  });

  it("lists providers once with provider ids, display names and searchable account names", () => {
    const cmds = __test.providerCommands({
      providers: [
        { id: "uuid-a", provider: "claude", name: "Account 1", testStatus: "active" },
        { id: "uuid-b", provider: "claude", name: "Backup account", testStatus: "error" },
      ],
    });
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({
      id: "provider:claude",
      run: { type: "navigate", href: "/dashboard/providers/claude" },
      providerId: "claude",
    });
    expect(cmds[0].label).not.toBe("Account 1");
    expect(cmds[0].hint).toBe("2 accounts · Test failed");
    expect(filterAndRank(cmds, "Backup account")).toHaveLength(1);
    expect(__test.providerCommands({ providers: [{ id: "bad", name: "Orphan" }] })).toEqual([]);
    expect(
      __test.providerCommands({ providers: [{ id: "bad", provider: "does-not-exist" }] }),
    ).toEqual([]);
  });

  it("keeps compatible providers and resolves model aliases to detail ids", () => {
    const compatibleId = "openai-compatible-example";
    const providers = __test.providerCommands({
      providers: [
        { id: "uuid-1", provider: compatibleId, name: "Custom gateway" },
        { id: "uuid-2", provider: compatibleId, name: "Second account" },
      ],
    });
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      label: "Custom gateway",
      run: { href: `/dashboard/providers/${compatibleId}` },
    });
    expect(
      __test.modelCommands({ models: [{ fullModel: "gc/example", provider: "gc" }] })[0].secondary
        .run.href,
    ).toBe("/dashboard/providers/gemini-cli");
    expect(
      __test.modelCommands({ models: [{ fullModel: "unknown/example", provider: "unknown" }] })[0]
        .secondary,
    ).toBeUndefined();
  });

  it("opens LLM combos by selection and media combos at their own detail route", () => {
    const combos = __test.comboCommands({
      combos: [
        { id: "test-1", name: "Primary", models: [] },
        { id: "web-1", name: "Search", kind: "webSearch", models: [] },
        { id: "img-1", name: "Images", kind: "image", models: [] },
      ],
    });
    expect(combos.map((c) => c.run.href)).toEqual([
      "/dashboard/combos?combo=test-1",
      "/dashboard/media-providers/combo/web-1",
      "/dashboard/media-providers/combo/img-1",
    ]);
  });

  it("produces quick action commands for endpoint, new key, theme and settings", () => {
    const actions = __test.actionCommands();
    expect(actions.map((a) => a.id)).toEqual([
      "action:copy-endpoint",
      "action:add-provider",
      "action:new-combo",
      "action:new-key",
      "action:test-providers",
      "action:refresh-quota",
      "action:open-request-log",
      "action:toggle-tunnel",
      "action:clear-console",
      "action:change-language",
      "action:toggle-theme",
      "action:sign-out",
      "action:open-settings",
    ]);
    expect(actions.find((a) => a.id === "action:new-key").run.href).toBe(
      "/dashboard/endpoint?create=key",
    );
  });

  it("collects static and registered sources together", async () => {
    const all = await collectCommands();
    expect(all.some((c) => c.id === "action:copy-endpoint")).toBe(true);
    expect(all.some((c) => c.id === "page:home")).toBe(true);
  });
});
