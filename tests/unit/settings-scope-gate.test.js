// YAN-769: the real useSettingsScope derivation (no mocks beyond auth state)
// across owner/admin/member/inactive, plus the host-probe factory's
// revocation contract.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No DOM renderer installed: execute the real derivation with useMemo inline.
vi.mock("react", () => ({ useMemo: (fn) => fn() }));
const capSpy = vi.hoisted(() => ({ can: null }));
vi.mock("@/lib/users/principal", async (importOriginal) => {
  const real = await importOriginal();
  capSpy.can = vi.fn(real.can);
  return { ...real, can: capSpy.can };
});
const authMock = vi.hoisted(() => ({ value: { status: {}, loaded: true } }));
vi.mock("@/shared/hooks/useAuthStatus", () => ({
  useAuthStatusState: () => authMock.value,
}));

import { useSettingsScope } from "@/shared/hooks/useSettingsScope";

// useSettingsScope is called in loops to compare derivations; suppression is
// the same pattern as the other hook-driver tests.
// biome-ignore lint/correctness/useHookAtTopLevel: derivations compared across seeded roles.
const scope = () => useSettingsScope();
import { makePingTunnelHealth } from "@/app/(dashboard)/dashboard/endpoint/hooks/useReachableSync";

const principal = (role, extra = {}) => ({
  principal: {
    role,
    user: { id: "u1" },
    workspaces: [{ id: "w1", name: "W", kind: "shared" }],
    activeWorkspaceId: "w1",
    ...extra,
  },
  multiUserActive: true,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useSettingsScope capability derivation", () => {
  it("owner/admin hold both caps; member holds neither", () => {
    for (const role of ["owner", "admin"]) {
      authMock.value = { status: principal(role), loaded: true };
      const s = scope();
      expect(s.ready).toBe(true);
      expect(s.canManageInstance).toBe(true);
      expect(s.canHostOps).toBe(true);
      expect(s.scope).toEqual({ workspaceId: "w1" });
    }
    authMock.value = { status: principal("user"), loaded: true };
    const m = scope();
    expect(m.canManageInstance).toBe(false);
    expect(m.canHostOps).toBe(false);
  });

  it("inactive (switch off / anonymous) allows everything with null scope, never calling can()", () => {
    capSpy.can.mockClear();
    for (const status of [{}, { principal: null }, { multiUserActive: false }]) {
      authMock.value = { status, loaded: true };
      const s = scope();
      expect(s.ready).toBe(true);
      expect(s.scope).toBeNull();
      expect(s.canManageInstance).toBe(true);
      expect(s.canHostOps).toBe(true);
    }
    expect(capSpy.can).not.toHaveBeenCalled(); // inactive view has no can()
  });

  it("active view asks can() for both instance capabilities", () => {
    capSpy.can.mockClear();
    authMock.value = { status: principal("admin"), loaded: true };
    scope();
    const asked = capSpy.can.mock.calls.map(([, cap]) => cap);
    expect(asked).toEqual(expect.arrayContaining(["instance.settings.manage", "instance.hostOps"]));
  });

  it("unresolved auth is not ready and allows nothing", () => {
    authMock.value = { status: {}, loaded: false };
    const s = scope();
    expect(s.ready).toBe(false);
    expect(s.canManageInstance).toBe(true); // view inactive => legacy-true
    expect(s.canHostOps).toBe(true);
  });

  it("does not throw on a malformed principal", () => {
    authMock.value = { status: { multiUserActive: true, principal: {} }, loaded: true };
    expect(() => scope()).not.toThrow();
  });
});

describe("makePingTunnelHealth revocation", () => {
  let fetchMock;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    fetchMock = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("stops probing and returns false once access is revoked", async () => {
    let allowed = true;
    const ping = makePingTunnelHealth({
      setLoading: () => {},
      setProgress: () => {},
      setStatus: vi.fn(),
      setEnabled: vi.fn(),
      isAllowed: () => allowed,
    });
    const p = ping("https://t.example");
    await vi.advanceTimersByTimeAsync(2000);
    allowed = false; // revoked mid-probe
    const ok = await vi.advanceTimersByTimeAsync(2000).then(() => p);
    expect(ok).toBe(false);
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchMock.mock.calls.length).toBe(calls); // loop stopped
  });

  it("never probes when access is already gone", async () => {
    const ping = makePingTunnelHealth({
      setLoading: () => {},
      setProgress: () => {},
      setStatus: vi.fn(),
      setEnabled: vi.fn(),
      isAllowed: () => false,
    });
    await expect(ping("https://t.example")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
