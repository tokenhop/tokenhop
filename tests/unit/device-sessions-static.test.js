// YAN-751: static guard that every dashboard session cookie is minted through
// the single choke point (sessionMint.js -> dashboardSession.js).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const MINT_FILE = "src/lib/users/sessionMint.js";
const COOKIE_FILE = "src/lib/auth/dashboardSession.js";
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;

// Recursive scan of src/ with plain fs (no .git dependency); repo-relative POSIX paths.
const sourceFiles = (dir = "src") =>
  readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(rel);
    return SOURCE_EXT.test(entry.name) ? [rel] : [];
  });

// Files under `dir` whose source matches `pattern`.
const scan = (pattern, dir = "src") =>
  sourceFiles(dir)
    .filter((file) => pattern.test(readFileSync(path.join(REPO_ROOT, file), "utf8")))
    .sort();

describe("session cookie choke point", () => {
  it("calls setDashboardAuthCookie( only from dashboardSession.js and sessionMint.js", () => {
    expect(scan(/setDashboardAuthCookie\(/)).toEqual([COOKIE_FILE, MINT_FILE].sort());
  });

  it("never calls setDashboardAuthCookie( from a route or page under src/app", () => {
    expect(scan(/setDashboardAuthCookie\(/, "src/app")).toEqual([]);
  });

  it("sets the auth_token cookie directly only inside dashboardSession.js", () => {
    expect(scan(/\.set\(\s*(?:["']auth_token["']|AUTH_COOKIE\b)/)).toEqual([COOKIE_FILE]);
  });

  it("keeps sessionMint.js free of a ./session.js import (cycle guard)", () => {
    const source = readFileSync(path.join(REPO_ROOT, MINT_FILE), "utf8");
    // Import statements only: the header comment legitimately names ./session.js.
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+["']([^"']+)["']/gm),
    ]
      .map((m) => m[1])
      .concat([...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]));
    expect(specifiers.length).toBeGreaterThan(0);
    const offenders = specifiers.filter((s) => /(^|\/)session(\.js)?$/.test(s));
    expect(offenders).toEqual([]);
  });
});
