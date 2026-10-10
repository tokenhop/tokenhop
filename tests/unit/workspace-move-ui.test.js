import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  confirmWarningsOf,
  issueDetailsText,
  moveConflictOf,
} from "../../src/shared/utils/workspaceMove";

// The exact shapes POST /api/workspaces/[id]/move returns (route.js fail()):
// 409 → { error: "Move has conflicts", code: "move_conflict", conflicts }
// 409 → { error: "Move needs confirmation", code: "confirm_required", warnings }
// Preview issues carry `details` as an object `{ count: n }` for count codes
// (workspaceMovePlan.js warn()); PROVIDER_TERMS carries no details.
const conflictBody = {
  error: "Move has conflicts",
  code: "move_conflict",
  conflicts: [{ type: "combo", id: "c1", code: "NAME_TAKEN", message: "taken" }],
};
const confirmBody = {
  error: "Move needs confirmation",
  code: "confirm_required",
  warnings: [
    {
      type: "connection",
      id: "k1",
      code: "GRANTS_REVOKED",
      message: "revoked",
      details: { count: 2 },
    },
  ],
};

describe("issueDetailsText (server warning objects)", () => {
  it("counts known codes as guarded text", () => {
    expect(issueDetailsText({ code: "GRANTS_REVOKED", details: { count: 2 } })).toBe(
      "2 active grants",
    );
    expect(issueDetailsText({ code: "GRANTS_REVOKED", details: { count: 1 } })).toBe(
      "1 active grant",
    );
    expect(issueDetailsText({ code: "COMBO_REF_NOT_MOVING", details: { count: 3 } })).toBe(
      "3 items stay behind",
    );
    expect(issueDetailsText({ code: "KEY_COMBO_REF", details: { count: 1 } })).toBe(
      "1 key stays behind",
    );
  });

  it("passes through safe primitives", () => {
    expect(issueDetailsText({ details: "plain string" })).toBe("plain string");
    expect(issueDetailsText({ details: 7 })).toBe("7");
  });

  it("never surfaces unknown object shapes", () => {
    expect(issueDetailsText({ details: { weird: true } })).toBeNull();
    expect(issueDetailsText({ details: { count: Number.NaN } })).toBeNull();
    expect(issueDetailsText({ details: ["a"] })).toBeNull();
    expect(issueDetailsText({ details: null })).toBeNull();
    expect(issueDetailsText({})).toBeNull();
  });

  it("renders without crashing React (the HIGH finding)", () => {
    // Rendering a raw {count} object would throw "Objects are not valid as a
    // React child"; the guarded text must render or render nothing.
    const markup = (details) =>
      renderToStaticMarkup(createElement("span", null, issueDetailsText(details)));
    expect(markup({ code: "GRANTS_REVOKED", details: { count: 2 } })).toBe(
      "<span>2 active grants</span>",
    );
    expect(markup({ details: { unexpected: { nested: true } } })).toBe("<span></span>");
  });
});

describe("409 body classification (route contract)", () => {
  it("move_conflict yields conflicts", () => {
    expect(moveConflictOf(conflictBody)).toEqual(conflictBody.conflicts);
    expect(moveConflictOf(confirmBody)).toBeNull();
    expect(moveConflictOf(null)).toBeNull();
    expect(moveConflictOf({ error: "MOVE_CONFLICT" })).toBeNull(); // old guess never matches
  });

  it("confirm_required yields warnings for the re-acknowledge path", () => {
    expect(confirmWarningsOf(confirmBody)).toEqual(confirmBody.warnings);
    expect(confirmWarningsOf(conflictBody)).toBeNull();
    expect(confirmWarningsOf({ error: "CONFIRM_REQUIRED" })).toBeNull(); // old guess
  });
});
