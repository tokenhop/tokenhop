import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Regression (YAN-376): audit page imported `Pagination` from the components
// barrel, which does not export it -> undefined component -> React #130 crash.
const root = resolve(__dirname, "../../src");
const read = (rel) => readFileSync(resolve(root, rel), "utf8");
const page = read("app/(dashboard)/dashboard/audit/page.js");
const barrel = read("shared/components/index.js");

const importFrom = (source, from) => {
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"${from}"`);
  return (source.match(re)?.[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

it("passes the no-access explanation through EmptyState body", () => {
  expect(page).toContain(
    'body="The audit log is available to workspace managers and instance admins."',
  );
});

describe("audit page imports resolve to real exports", () => {
  it("every name imported from the barrel is exported by it", () => {
    const names = importFrom(page, "@/shared/components");
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(barrel, `${name} missing from barrel`).toMatch(
        new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}|as\\s+${name}\\b`),
      );
    }
  });

  it("imports Pagination from its own module (default export exists)", () => {
    expect(page).toContain('import Pagination from "@/shared/components/Pagination"');
    expect(existsSync(resolve(root, "shared/components/Pagination.js"))).toBe(true);
    expect(read("shared/components/Pagination.js")).toMatch(/export default function Pagination\b/);
  });
});
