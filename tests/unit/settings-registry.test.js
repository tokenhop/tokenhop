import { describe, it, expect } from "vitest";
import {
  SETTINGS_SECTIONS,
  SETTINGS_GROUPS,
  filterRows,
  sectionAnchors,
  toCommandItems,
  SETTINGS_ANCHORS,
} from "@/app/(dashboard)/dashboard/settings/registry.js";

describe("settings registry", () => {
  it("declares in-scope sections with id, title and icon", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      "general",
      "security",
      "sso",
      "routing",
      "reliability",
      "network",
      "token-saver",
      "providers",
      "logs",
      "pricing",
      "about",
      "data",
      "environment",
      "danger",
    ]);
    for (const section of SETTINGS_SECTIONS) {
      expect(section.title).toBeTruthy();
      expect(section.icon).toBeTruthy();
      expect(Array.isArray(section.rows)).toBe(true);
    }
  });

  it("rows declare key, label, description, keywords", () => {
    for (const section of SETTINGS_SECTIONS) {
      for (const row of section.rows) {
        expect(row.key).toBeTruthy();
        expect(row.label).toBeTruthy();
        expect(typeof row.keywords).toBe("string");
      }
    }
  });
});

describe("SETTINGS_GROUPS", () => {
  it("places every section in exactly one group", () => {
    const grouped = SETTINGS_GROUPS.flatMap((group) => group.sections);
    expect(grouped.toSorted()).toEqual(SETTINGS_SECTIONS.map((s) => s.id).toSorted());
  });
});

describe("filterRows", () => {
  it("returns all rows on empty query", () => {
    const result = filterRows("");
    expect(result.length).toBe(SETTINGS_SECTIONS.length);
    expect(result.every((s) => s.rows.length > 0)).toBe(true);
  });

  it("matches label, description and key case-insensitively", () => {
    expect(filterRows("password")[0].rows.some((r) => r.key === "password")).toBe(true);
    expect(filterRows("REQUIRELOGIN")[0].rows.some((r) => r.key === "requireLogin")).toBe(true);
    expect(filterRows("oidc")[0].rows.some((r) => r.key.includes("oidc"))).toBe(true);
  });

  it("drops sections with no matching rows", () => {
    const result = filterRows("zzz-no-such-setting");
    expect(result).toEqual([]);
  });
});

describe("sectionAnchors", () => {
  it("returns id + title pairs in section order", () => {
    expect(sectionAnchors()).toEqual(SETTINGS_ANCHORS);
    expect(SETTINGS_ANCHORS[0]).toMatchObject({ id: "general", title: "General" });
  });
});

describe("toCommandItems", () => {
  it("exports one Settings-group command per row for the palette", () => {
    const items = toCommandItems();
    expect(items.length).toBeGreaterThan(10);
    for (const item of items) {
      expect(item.group).toBe("Settings");
      expect(item.href).toMatch(/^\/dashboard\/settings#/);
      expect(item.run).toEqual({ type: "navigate", href: item.href });
      expect(item.label).toBeTruthy();
      expect(item.keywords).toContain(item.label.split(" — ")[1]);
    }
    expect(items.some((i) => i.href === "/dashboard/settings#pricing")).toBe(true);
    expect(items.some((i) => i.href === "/dashboard/settings#logs")).toBe(true);
    expect(items.some((i) => i.href === "/dashboard/settings#environment")).toBe(true);
  });
});
