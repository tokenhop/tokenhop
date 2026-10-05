// YAN-351: the users & teams switch. CI runs the suite with TOKENHOP_MULTI_USER
// both off and on, so every case here pins the env it needs.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV = "TOKENHOP_MULTI_USER";
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
let saved;

beforeEach(async () => {
  saved = process.env[ENV];
  delete process.env[ENV];
  vi.resetModules();
  // DATA_DIR is per file: reset the stored switch so cases don't depend on order.
  const { updateSettings } = await import("@/lib/db/index.js");
  await updateSettings({ multiUserEnabled: false });
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
  vi.resetModules();
});

const load = () => import("@/lib/users/featureSwitch.js");
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
const store = async (value) => {
  const { updateSettings } = await import("@/lib/db/index.js");
  await updateSettings({ multiUserEnabled: value });
};

describe("isMultiUserEnabled precedence", () => {
  it("defaults to off on a fresh install", async () => {
    const { isMultiUserEnabled } = await load();
    expect(await isMultiUserEnabled()).toBe(false);
  });

  it("falls back to the stored setting when the env is unset or empty", async () => {
    await store(true);
    expect(await (await load()).isMultiUserEnabled()).toBe(true);
    vi.resetModules();
    process.env[ENV] = "";
    expect(await (await load()).isMultiUserEnabled()).toBe(true);
  });

  it("env on/off wins over the stored setting", async () => {
    await store(true);
    process.env[ENV] = "off";
    expect(await (await load()).isMultiUserEnabled()).toBe(false);
    await store(false);
    vi.resetModules();
    process.env[ENV] = "on";
    expect(await (await load()).isMultiUserEnabled()).toBe(true);
  });

  it.each(["true", "1", "ON", "yes", " on"])("fails fast on invalid env %j", async (value) => {
    process.env[ENV] = value;
    await expect(load()).rejects.toThrow(/TOKENHOP_MULTI_USER: invalid value/);
  });
});

describe("requireMultiUser", () => {
  it("answers 404 while off and passes through while on", async () => {
    process.env[ENV] = "off";
    const off = await (await load()).requireMultiUser();
    expect(off.status).toBe(404);
    vi.resetModules();
    process.env[ENV] = "on";
    expect(await (await load()).requireMultiUser()).toBeNull();
  });

  it("hides every guarded route while off", async () => {
    // Add each multi-user route here as it lands: a route missing the guard fails.
    const GUARDED_ROUTES = [
      "src/app/api/auth/logout-all/route.js",
      "src/app/api/auth/setup-token/route.js",
      "src/app/api/me/preferences/route.js",
      "src/app/api/workspaces/[id]/settings/route.js",
    ];
    const found = gitGrep(["requireMultiUser", "--", "src/app/**/route.js"]);
    expect(found).toEqual([...GUARDED_ROUTES].sort());
    process.env[ENV] = "off";
    for (const file of found) {
      const mod = await import(path.join(REPO_ROOT, file));
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        if (typeof mod[method] !== "function") continue;
        const req = new Request("http://localhost/x", { method });
        const res = await mod[method](req, { params: Promise.resolve({}) });
        expect(res.status, `${method} ${file}`).toBe(404);
      }
    }
  });
});

describe("multiUserEnabled setting", () => {
  it("is off in the defaults, hidden from GET and not writable through PATCH /api/settings", async () => {
    const { DEFAULT_SETTINGS } = await import("@/lib/db/repos/settingsRepo.js");
    expect(DEFAULT_SETTINGS.multiUserEnabled).toBe(false);
    const { PATCH } = await import("@/app/api/settings/route.js");
    const res = await PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ multiUserEnabled: true }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await (await load()).isMultiUserEnabled()).toBe(false);
    const { GET } = await import("@/app/api/settings/route.js");
    expect(await (await GET()).json()).not.toHaveProperty("multiUserEnabled");
  });

  it("is not restored from a database backup", async () => {
    const { exportDb } = await import("@/lib/db/index.js");
    const { getCliToken } = await import("@/lib/auth/cliToken");
    const backup = await exportDb();
    backup.settings = { ...backup.settings, multiUserEnabled: true };
    const { POST } = await import("@/app/api/settings/database/route.js");
    const res = await POST(
      new Request("http://localhost/api/settings/database", {
        method: "POST",
        headers: { "x-9r-cli-token": await getCliToken() },
        body: JSON.stringify(backup),
      }),
    );
    expect(res.status).toBe(200);
    expect(await (await load()).isMultiUserEnabled()).toBe(false);
  });

  it("has a single reader: only featureSwitch.js names the env var or the setting", () => {
    const hits = gitGrep([
      "-E",
      "TOKENHOP_MULTI_USER|MULTI_USER\\b|multiUserEnabled",
      "--",
      "src",
      "open-sse",
      "cli",
    ]);
    // Defaults and the denylists name the key to hide or reject it; they never read it.
    expect(hits).toEqual([
      "src/app/api/settings/database/route.js",
      "src/app/api/settings/route.js",
      "src/app/api/settings/validateSectionSettings.js",
      "src/lib/db/repos/settingsRepo.js",
      "src/lib/settingsConfigDoc.js",
      "src/lib/users/featureSwitch.js",
    ]);
  });
});
