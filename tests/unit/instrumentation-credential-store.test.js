// YAN-1037 L3: the credential store is installed early and a failure only warns.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  startup: vi.fn(async () => {
    throw new Error("startup boom");
  }),
}));

vi.mock("@/lib/db/processLock.js", () => ({ isStartupExcludedBuildPhase: () => false }));
vi.mock("@/lib/db/startupReadiness.js", () => ({ ensureGatewayKeyStartup: mocks.startup }));
vi.mock("@/sse/services/credentialStore.js", () => ({ installCredentialStore: mocks.install }));

const originalRuntime = process.env.NEXT_RUNTIME;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_RUNTIME = "nodejs";
});

afterEach(() => {
  if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = originalRuntime;
  vi.restoreAllMocks();
});

describe("instrumentation register()", () => {
  it("installs the credential store before steps that can throw", async () => {
    const { register } = await import("../../src/instrumentation.js");
    await expect(register()).rejects.toThrow("startup boom");
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  it("a failing install only warns and does not mask the startup result", async () => {
    mocks.install.mockImplementation(() => {
      throw new Error("install boom");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { register } = await import("../../src/instrumentation.js");
    await expect(register()).rejects.toThrow("startup boom");
    expect(warn.mock.calls.flat().join(" ")).toContain("install boom");
  });
});
