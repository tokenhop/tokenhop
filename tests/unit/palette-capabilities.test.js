// YAN-750: palette pages/settings follow sidebar capabilities and settings tiers.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { accountView } from "@/shared/utils/account";
import { MEDIA_TABS, visibleItems } from "@/shared/constants/navigation";
import { collectCommands } from "@/shared/utils/commandPalette";
import { __test } from "@/shared/utils/commandSources";
import { SETTINGS_SECTIONS, toCommandItems } from "@/app/(dashboard)/dashboard/settings/registry";
import { ACCOUNT_SECTION, layoutFor } from "@/app/(dashboard)/dashboard/settings/settingsTiers";

function status(role, workspaceRole = "owner") {
  return {
    multiUserActive: true,
    principal: {
      user: { id: "u1", username: "Ann" },
      role,
      activeWorkspaceId: "ws1",
      workspaces: [{ id: "ws1", name: "Ann", kind: "personal", role: workspaceRole }],
    },
  };
}

const contextFor = (role, workspaceRole) => ({
  view: accountView(status(role, workspaceRole)),
  multiUser: true,
  enableTranslator: true,
});
const pageIds = (commands) => commands.map((c) => c.id);
const settingsHrefs = (commands) => [...new Set(commands.map((c) => c.href))];

describe("palette capabilities", () => {
  it("member pages match sidebar metadata, with no instance-only pages", () => {
    const context = contextFor("user");
    const commands = __test.pageCommands(context);
    expect(pageIds(commands)).toEqual([
      ...visibleItems({ ...context, can: context.view.can }).map((i) => `page:${i.id}`),
      ...MEDIA_TABS.map((i) => `page:media-${i.id}`),
    ]);
    for (const id of ["console-log", "token-saver", "proxy-pools", "translator"]) {
      expect(pageIds(commands)).not.toContain(`page:${id}`);
    }
    expect(pageIds(commands)).toContain("page:cli-tools"); // YAN-374 copy config
  });

  it("admin pages include authorized instance pages and respect feature gates", () => {
    const context = contextFor("admin");
    expect(pageIds(__test.pageCommands(context))).toContain("page:audit");
    expect(pageIds(__test.pageCommands(context))).toContain("page:translator");
    expect(pageIds(__test.pageCommands({ ...context, enableTranslator: false }))).not.toContain(
      "page:translator",
    );
    expect(pageIds(__test.pageCommands({ ...context, multiUser: false }))).not.toContain(
      "page:audit",
    );
  });

  it("member settings contain only My account and Workspace layout rows", () => {
    const view = contextFor("user").view;
    const commands = toCommandItems(view);
    expect(settingsHrefs(commands)).toEqual(
      layoutFor(view).sections.map((s) => `/dashboard/settings#${s.id}`),
    );
    for (const row of ACCOUNT_SECTION.rows) {
      expect(commands).toContainEqual(
        expect.objectContaining({
          label: `My account — ${row.label}`,
          href: "/dashboard/settings#account",
        }),
      );
    }
    expect(settingsHrefs(toCommandItems(contextFor("user", "member").view))).toEqual([
      "/dashboard/settings#account",
      "/dashboard/settings#general",
      "/dashboard/settings#about",
    ]);
  });

  it("admin settings include all rows with unique IDs and separate passwords", () => {
    const commands = toCommandItems(contextFor("admin").view);
    expect(commands).toHaveLength(
      [...ACCOUNT_SECTION.rows, ...SETTINGS_SECTIONS.flatMap((s) => s.rows)].length,
    );
    expect(new Set(pageIds(commands)).size).toBe(commands.length);
    expect(commands.filter((c) => c.label.endsWith(" — Password")).map((c) => c.href)).toEqual([
      "/dashboard/settings#account",
      "/dashboard/settings#security",
    ]);
  });

  it("registered sources receive viewer context on initial and lazy collection", async () => {
    const context = contextFor("user");
    for (const models of [null, [{ id: "test/model", provider: "test" }]]) {
      const commands = await collectCommands({ ...context, models });
      expect(commands.filter((c) => c.group === "Pages")).toEqual(__test.pageCommands(context));
      expect(commands.filter((c) => c.group === "Settings")).toEqual(toCommandItems(context.view));
      expect(pageIds(commands)).not.toContain("page:console-log");
      expect(commands.some((c) => c.label.startsWith("My account — "))).toBe(true);
    }
  });

  it("inactive output is identical, even with switch gates and a denying can", async () => {
    const legacy = await collectCommands();
    for (const authStatus of [{}, { ...status("user"), multiUserActive: false }]) {
      const view = { ...accountView(authStatus), can: () => false };
      expect(await collectCommands({ view, multiUser: true, enableTranslator: true })).toEqual(
        legacy,
      );
      expect(toCommandItems(view)).toEqual(toCommandItems());
    }
    expect(legacy.filter((c) => c.group === "Settings")).toHaveLength(
      SETTINGS_SECTIONS.flatMap((s) => s.rows).length,
    );
    expect(pageIds(legacy)).not.toContain("settings:account:profile");
  });
});

// CommandPaletteProvider.js holds JSX in a .js file, which vite cannot import
// (same constraint as palette-workspace-race.test.js), and the tests package has
// no DOM renderer. Pin the effect wiring on the real source instead.
describe("palette provider effects", () => {
  const source = readFileSync(
    resolve(__dirname, "../../src/shared/components/CommandPaletteProvider.js"),
    "utf8",
  );
  const effects = [...source.matchAll(/useEffect\(\(\) => \{([\s\S]*?\}, \[[^\]]*\]\);)/g)].map(
    (match) => match[1],
  );
  const effectWith = (needle) => effects.filter((e) => e.includes(needle));

  it("resets query/activeId only when the palette opens, not when gates resolve", () => {
    const resets = effectWith('setQuery("")');
    expect(resets).toHaveLength(1);
    expect(resets[0]).toContain("setActiveId(null)");
    expect(resets[0]).toContain("}, [open]);");
    expect(resets[0]).not.toContain("collectCommands");
  });

  it("builds commands only after auth and shell gates resolve", () => {
    expect(source).toContain("const sourcesReady = ready && authLoaded && !shellLoading;");
    const refreshes = effectWith("collectCommands(");
    expect(refreshes).toHaveLength(2);
    for (const effect of refreshes) {
      expect(effect).toContain("!sourcesReady) return;");
      expect(effect).toContain("view, multiUser, enableTranslator");
      expect(effect).not.toContain('setQuery("")');
    }
  });
});
