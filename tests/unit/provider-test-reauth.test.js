/**
 * YAN-1038: the provider Test action must not probe upstream or write health for a
 * connection that needs re-authentication (the repo drops the health write anyway,
 * so a "valid" result would contradict the persisted flagged state).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;
const HOUR = 3600 * 1000;

async function runTest(connection) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve("{}"),
  });
  global.fetch = fetchMock;
  const updates = [];
  vi.doMock("@/lib/localDb", () => ({
    getProviderConnectionByIdUnscoped: vi.fn(async () => connection),
    updateProviderConnectionUnscoped: vi.fn(async (_id, data) => updates.push(data)),
  }));
  vi.doMock("@/lib/network/connectionProxy", () => ({
    resolveConnectionProxyConfig: vi.fn(async () => ({})),
  }));
  const { testSingleConnection } = await import(
    "../../src/app/api/providers/[id]/test/testUtils.js"
  );
  const result = await testSingleConnection(connection.id);
  return { result, fetchMock, updates };
}

const flagged = (reason) => ({
  reason,
  code: "invalid_grant",
  at: new Date().toISOString(),
});

describe("provider Test on a connection that needs re-authentication", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.doUnmock("@/lib/localDb");
    vi.doUnmock("@/lib/network/connectionProxy");
    global.fetch = originalFetch;
  });

  it("returns invalid with the fixed lastError for a flagged row, with no probe and no write", async () => {
    const { result, fetchMock, updates } = await runTest({
      id: "c1",
      provider: "codex",
      authType: "oauth",
      accessToken: "still-working-at",
      refreshToken: "dead-rt",
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
      reauthRequired: flagged("refresh_token_rejected"),
    });
    expect(result).toMatchObject({ valid: false, error: "Token expired and refresh failed" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("uses the access-token message for an access_token flag", async () => {
    const { result, fetchMock, updates } = await runTest({
      id: "c2",
      provider: "codex",
      authType: "access_token",
      accessToken: "at",
      reauthRequired: flagged("access_token_expired"),
    });
    expect(result).toMatchObject({ valid: false, error: "Token expired" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("also short-circuits an unflagged, already expired access-token-only row", async () => {
    const { result, fetchMock, updates } = await runTest({
      id: "c3",
      provider: "codex",
      authType: "access_token",
      accessToken: "at",
      expiresAt: new Date(Date.now() - HOUR).toISOString(),
    });
    expect(result).toMatchObject({ valid: false, error: "Token expired" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});
