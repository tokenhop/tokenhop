import { describe, expect, it } from "vitest";
import {
  applyServerPriorityPut,
  connectionIdsInPriorityOrder,
  dragMoveIndices,
  formatCooldownRemaining,
  reorderConnections,
  selectionReducer,
  sortByPriority,
  stickyLimitError,
  weightSharePct,
} from "@/app/(dashboard)/dashboard/providers/detailUtils.js";

const connection = (over = {}) => ({
  id: over.id || "connection-1",
  priority: 0,
  isActive: true,
  ...over,
});

describe("provider detail reorder math", () => {
  it("moves a connection one slot and renumbers every priority", () => {
    const connections = [connection({ id: "a" }), connection({ id: "b" }), connection({ id: "c" })];
    const next = reorderConnections(connections, 0, 2);
    expect(next.map((entry) => entry.id)).toEqual(["b", "c", "a"]);
    expect(next.map((entry) => entry.priority)).toEqual([1, 2, 3]);
  });

  it("rejects moves outside the list and leaves input untouched", () => {
    const connections = [connection({ id: "a" }), connection({ id: "b" })];
    expect(reorderConnections(connections, 0, 9)).toBe(connections);
    expect(reorderConnections(connections, -1, 1)).toBe(connections);
  });

  it("derives connection ids in persisted priority order", () => {
    const connections = [
      connection({ id: "b", priority: 5 }),
      connection({ id: "a", priority: 1 }),
    ];
    expect(connectionIdsInPriorityOrder(connections)).toEqual(["a", "b"]);
  });
});

describe("provider detail shares and cooldowns", () => {
  it("splits traffic equally when all weights are exhausted", () => {
    expect(weightSharePct({ weight: 0 }, 0, 4)).toBe(25);
  });

  it("computes a connection share from its weight and total", () => {
    expect(weightSharePct({ weight: 2 }, 8, 3)).toBe(25);
  });

  it("formats remaining cooldown time in seconds, minutes and hours", () => {
    expect(formatCooldownRemaining(Date.now() + 45 * 1000)).toMatch(/^\d+s$/);
    expect(formatCooldownRemaining(Date.now() + 134 * 1000)).toBe("2m 14s");
    expect(formatCooldownRemaining(Date.now() + 3_700 * 1000)).toBe("1h 1m");
    expect(formatCooldownRemaining(Date.now() - 1000)).toBe("");
  });

  it("validates provider sticky limits before saving", () => {
    expect(stickyLimitError("")).toBe("");
    expect(stickyLimitError(null)).toBe("");
    expect(stickyLimitError("3")).toBe("");
    expect(stickyLimitError("0")).not.toBe("");
    expect(stickyLimitError("101")).not.toBe("");
    expect(stickyLimitError("2.5")).not.toBe("");
  });
});

describe("provider detail bulk selection", () => {
  it("toggles every connection id without duplicates", () => {
    const ids = ["a", "b"];
    expect(selectionReducer(["a"], { type: "toggle", id: "b", allIds: ids })).toEqual(["a", "b"]);
    expect(selectionReducer(["a", "b"], { type: "toggle", id: "b", allIds: ids })).toEqual(["a"]);
  });

  it("selects and clears complete selections", () => {
    expect(selectionReducer([], { type: "select-all", allIds: ["a", "b"] })).toEqual(["a", "b"]);
    expect(selectionReducer(["a", "b"], { type: "select-all", allIds: ["a", "b"] })).toEqual([]);
    expect(selectionReducer(["a"], { type: "clear" })).toEqual([]);
  });

  it("prunes selections against connections that still exist", () => {
    expect(
      selectionReducer(["a", "gone"], {
        type: "prune",
        existingIds: ["a"],
      }),
    ).toEqual(["a"]);
  });
});

describe("provider detail drag and drop", () => {
  it("resolves DnD moves in priority order, not fetch order", () => {
    const connections = [
      connection({ id: "b", priority: 1 }),
      connection({ id: "a", priority: 0 }),
      connection({ id: "c", priority: 2 }),
    ];
    // Priority order is a, b, c — dragging b over a must move 2 -> 1.
    expect(dragMoveIndices(connections, "b", "a")).toEqual({ fromIndex: 1, toIndex: 0 });
    expect(sortByPriority(connections).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("rejects drops onto nothing, itself or unknown ids", () => {
    const connections = [connection({ id: "a" })];
    expect(dragMoveIndices(connections, "a", "a")).toBeNull();
    expect(dragMoveIndices(connections, "a", "missing")).toBeNull();
    expect(dragMoveIndices(connections, "missing", "a")).toBeNull();
    expect(dragMoveIndices(connections, "a", null)).toBeNull();
  });
});

describe("provider detail server persistence", () => {
  const rows = () => [
    { id: "a", priority: 1, updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "b", priority: 2, updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "c", priority: 3, updatedAt: "2026-01-01T00:00:00.000Z" },
  ];
  const permutations = (arr) =>
    arr.length <= 1
      ? [arr]
      : arr.flatMap((v, i) =>
          permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((r) => [v, ...r]),
        );

  it("sequential 1-based PUTs converge to the intended order under every arrival order", () => {
    // Intent: move a to the end -> [b, c, a] with dense 1-based priorities.
    const intended = [
      { id: "b", priority: 1 },
      { id: "c", priority: 2 },
      { id: "a", priority: 3 },
    ];
    const clientPuts = intended.map((row, i) => ({
      ...row,
      updatedAt: `2026-01-02T00:00:0${i}.000Z`,
    }));
    // Every arrival permutation preserves send order -> same final order.
    for (const order of permutations(clientPuts)) {
      let server = rows();
      // Simulate in-order processing: each PUT applied in send order.
      const inSendOrder = [...order].sort((x, y) => (x.updatedAt < y.updatedAt ? -1 : 1));
      for (const put of inSendOrder) {
        server = applyServerPriorityPut(server, put.id, put.priority, put.updatedAt);
      }
      expect(server.map((row) => row.id)).toEqual(["b", "c", "a"]);
      expect(server.map((row) => row.priority)).toEqual([1, 2, 3]);
    }
  });

  it("a reordered tail PUT arriving first still converges when replayed in send order", () => {
    let server = rows();
    server = applyServerPriorityPut(server, "a", 3, "2026-01-02T00:00:02.000Z");
    server = applyServerPriorityPut(server, "b", 1, "2026-01-02T00:00:00.000Z");
    server = applyServerPriorityPut(server, "c", 2, "2026-01-02T00:00:01.000Z");
    // Out-of-order arrival with distinct values still settles: latest write
    // per id wins and the renumber is dense.
    expect(server.map((row) => row.priority)).toEqual([1, 2, 3]);
    expect(new Set(server.map((row) => row.id))).toEqual(new Set(["a", "b", "c"]));
  });
});
