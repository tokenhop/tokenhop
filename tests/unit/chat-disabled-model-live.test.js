// YAN-1106: the per-request disabled-model check reads storage live and fails
// closed on credential-state errors; settings layers and scoped resources are
// each read once per request. Split from budget-leaf-single-resolution.test.js.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, disabledHook } = vi.hoisted(() => {
  process.env.TOKENHOP_MULTI_USER = "on";
  return {
    executeMock: vi.fn(),
    disabledHook: { fn: null },
  };
});

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute: executeMock }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  notifyRequestLogsEnabled: vi.fn(),
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", async (importOriginal) => ({
  ...(await importOriginal()),
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetailUnscoped: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/gatewayResources.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getGatewayDisabled: (...a) => {
      disabledHook.fn?.();
      return actual.getGatewayDisabled(...a);
    },
  };
});

import { getAdapter } from "@/lib/db/driver.js";
import { getProviderAlias } from "@/shared/constants/providers.js";
import { NOW, chat, ok, seedLeafDb, setBudget } from "../helpers/budgetLeafFixture.js";

let db;
const budget = (limits) => setBudget(db, limits);

beforeEach(async () => {
  db = await getAdapter();
  seedLeafDb(db);
  executeMock.mockReset();
  executeMock.mockImplementation(async () => ok());
  disabledHook.fn = null;
});

afterAll(() => {
  delete process.env.TOKENHOP_MASTER_KEY;
  delete process.env.TOKENHOP_PEER_TOKEN;
  delete process.env.TOKENHOP_MULTI_USER;
});

describe("live disabled-model check", () => {
  it("reads each settings layer and scoped resource once per request (YAN-1106)", async () => {
    budget({ requests: 5 });
    await (await chat()).text(); // warm module-level caches (observability config etc.)
    const get = vi.spyOn(db, "get");
    const all = vi.spyOn(db, "all");
    try {
      await (await chat()).text();
      const sqls = [...get.mock.calls, ...all.mock.calls].map(([sql]) => String(sql));
      const count = (re) => sqls.filter((sql) => re.test(sql)).length;
      expect(count(/FROM settings WHERE id = 1/)).toBe(1);
      expect(count(/FROM workspaceSettings/)).toBe(1);
      expect(count(/FROM userPreferences/)).toBe(1);
      // Both disabled checks (dispatch-time and post-reserve) read storage live.
      expect(count(/FROM kv WHERE scope = \? AND substr/)).toBe(2);
    } finally {
      get.mockRestore();
      all.mockRestore();
    }
  });

  for (const code of [
    "KEY_MISMATCH",
    "CREDENTIAL_STATE_INVALID",
    "CREDENTIAL_MAINTENANCE_POISONED",
    "API_KEY_STATE_INVALID",
  ]) {
    for (const withBudget of [false, true]) {
      it(`${code} from the disabled check fails closed (503, no upstream)${withBudget ? " under a budget" : ""}`, async () => {
        if (withBudget) budget({ requests: 1000 });
        disabledHook.fn = () => {
          throw Object.assign(new Error(code), { code });
        };
        try {
          const res = await chat();
          expect(res.status).toBe(503);
          expect(executeMock).not.toHaveBeenCalled();
        } finally {
          disabledHook.fn = null;
        }
      });
    }
  }

  it("a plain DB error from the disabled check stays fail-open", async () => {
    disabledHook.fn = () => {
      throw new Error("db down");
    };
    try {
      const res = await chat();
      expect(res.status).toBe(200);
      expect(executeMock).toHaveBeenCalledTimes(1);
    } finally {
      disabledHook.fn = null;
    }
  });

  it("without budgets, a model disabled between combo hops is not served on the next hop", async () => {
    const key = `ws:w1/${getProviderAlias("openai")}`;
    const insertCombo = (name, models) =>
      db.run(
        "INSERT INTO combos(id,name,kind,models,workspaceId,createdAt,updatedAt) VALUES (?, ?, 'llm', ?, 'w1', ?, ?)",
        [`combo-${name}`, name, JSON.stringify(models), NOW, NOW],
      );
    insertCombo("hops", ["openai/gpt-4o", "openai/gpt-4o-mini"]);
    // Hop 1 fails upstream; the model of hop 2 is disabled while hop 1 runs.
    executeMock.mockImplementationOnce(async () => {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('disabledModels', ?, '["gpt-4o-mini"]')
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [key],
      );
      return { response: new Response("boom", { status: 500 }), url: "x", headers: {} };
    });
    try {
      const res = await chat("hops");
      await res.text();
      expect(res.status).not.toBe(200);
      // Only hop 1 reached the upstream; the disabled hop-2 model never did.
      expect(executeMock).toHaveBeenCalledTimes(1);
    } finally {
      db.run("DELETE FROM kv WHERE scope = 'disabledModels' AND key = ?", [key]);
    }
  });
});
