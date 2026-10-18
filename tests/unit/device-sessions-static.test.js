// YAN-751: static guard that every dashboard session cookie is minted through
// the single choke point (sessionMint.js -> dashboardSession.js).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const MINT_FILE = "src/lib/users/sessionMint.js";
const COOKIE_FILE = "src/lib/auth/dashboardSession.js";

// Tracked + untracked files matching; git grep exits 1 when nothing matches.
const gitGrep = (args) => {
  try {
    return execFileSync("git", ["grep", "--untracked", "-l", ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .sort();
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
};

describe("session cookie choke point", () => {
  it("calls setDashboardAuthCookie( only from dashboardSession.js and sessionMint.js", () => {
    const files = gitGrep(["-F", "setDashboardAuthCookie(", "--", "src/"]);
    expect(files).toEqual([COOKIE_FILE, MINT_FILE].sort());
  });

  it("never calls setDashboardAuthCookie( from a route or page under src/app", () => {
    expect(gitGrep(["-F", "setDashboardAuthCookie(", "--", "src/app/"])).toEqual([]);
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
