import { describe, expect, it } from "vitest";
import { GO_TO, matchGoTo } from "@/shared/utils/goToShortcuts.js";

describe("matchGoTo", () => {
  it("maps each g chord to its page", () => {
    for (const [key, [, href]] of Object.entries(GO_TO)) {
      const first = matchGoTo(null, "g", 100);
      expect(matchGoTo(first.pending, key, 200).href).toBe(href);
    }
  });

  it("expires, ignores unknown keys, opens help and respects blocking", () => {
    expect(matchGoTo({ at: 0 }, "p", 900).href).toBeNull();
    expect(matchGoTo({ at: 0 }, "x", 1).href).toBeNull();
    expect(matchGoTo({ at: 0 }, "constructor", 1).href).toBeNull();
    expect(matchGoTo(null, "?", 1).help).toBe(true);
    expect(matchGoTo({ at: 0 }, "p", 1, true)).toEqual({ pending: null, href: null, help: false });
  });
});
