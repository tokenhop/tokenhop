// YAN-1159: the real useSettingsScope derivation (no mocks beyond auth state)
// yields connection capabilities mirroring server-side gating:
// member (use, no read), viewer (neither), manager+ (both), inactive true.
import { afterEach, describe, expect, it, vi } from "vitest";

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

const statusFor = (workspaceRole, role = "user") => ({
  multiUserActive: true,
  principal: {
    role,
    user: { id: "u1" },
    workspaces: [{ id: "w1", name: "W", kind: "shared", role: workspaceRole }],
    activeWorkspaceId: "w1",
  },
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useSettingsScope connection capabilities", () => {
  it("member holds use but not read; viewer holds neither", () => {
    authMock.value = { status: statusFor("member"), loaded: true };
    expect(scope()).toMatchObject({
      ready: true,
      canReadConnections: false,
      canUseConnections: true,
    });
    authMock.value = { status: statusFor("viewer"), loaded: true };
    expect(scope()).toMatchObject({
      ready: true,
      canReadConnections: false,
      canUseConnections: false,
    });
  });

  it("manager and workspace owner hold both", () => {
    for (const workspaceRole of ["manager", "owner"]) {
      authMock.value = { status: statusFor(workspaceRole), loaded: true };
      expect(scope()).toMatchObject({ canReadConnections: true, canUseConnections: true });
    }
  });

  it("instance owner/admin oversight does not grant connection use to a workspace viewer", () => {
    for (const role of ["admin", "owner"]) {
      authMock.value = { status: statusFor("viewer", role), loaded: true };
      expect(scope()).toMatchObject({ canReadConnections: true, canUseConnections: false });
    }
  });

  it("inactive (switch off / anonymous) holds both with null scope, never calling can()", () => {
    capSpy.can.mockClear();
    for (const status of [{}, { principal: null }, { multiUserActive: false }]) {
      authMock.value = { status, loaded: true };
      const s = scope();
      expect(s.scope).toBeNull();
      expect(s).toMatchObject({ canReadConnections: true, canUseConnections: true });
    }
    expect(capSpy.can).not.toHaveBeenCalled();
  });

  it("unresolved auth is not ready but defaults to legacy-true", () => {
    authMock.value = { status: {}, loaded: false };
    const s = scope();
    expect(s.ready).toBe(false);
    expect(s).toMatchObject({ canReadConnections: true, canUseConnections: true });
  });

  it("active view queries both connection capabilities", () => {
    capSpy.can.mockClear();
    authMock.value = { status: statusFor("member"), loaded: true };
    scope();
    const asked = capSpy.can.mock.calls.map(([, cap]) => cap);
    expect(asked).toEqual(
      expect.arrayContaining(["workspace.connections.metadata.read", "workspace.connections.use"]),
    );
  });
});
