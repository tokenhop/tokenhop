import { describe, expect, it } from "vitest";
import { groupSelectOptions } from "@/shared/utils/selectOptions";

describe("groupSelectOptions", () => {
  const a = { value: "a", label: "A" };
  const b = { value: "b", label: "B" };
  const c = { value: "c", label: "C" };

  it("keeps ungrouped options as a single unchanged run", () => {
    expect(groupSelectOptions([a, b])).toEqual([{ label: null, options: [a, b] }]);
  });

  it("combines consecutive options with the same group", () => {
    const first = { ...a, group: "Alpha" };
    const second = { ...b, group: "Alpha" };
    const third = { ...c, group: "Beta" };
    expect(groupSelectOptions([first, second, third])).toEqual([
      { label: "Alpha", options: [first, second] },
      { label: "Beta", options: [third] },
    ]);
  });

  it("preserves interleaved ungrouped and grouped order", () => {
    const grouped = { ...b, group: "Alpha" };
    expect(groupSelectOptions([a, grouped, c])).toEqual([
      { label: null, options: [a] },
      { label: "Alpha", options: [grouped] },
      { label: null, options: [c] },
    ]);
  });

  it("keeps repeated non-consecutive labels in separate runs", () => {
    const first = { ...a, group: "Alpha" };
    const middle = { ...b, group: "Beta" };
    const last = { ...c, group: "Alpha" };
    expect(groupSelectOptions([first, middle, last])).toEqual([
      { label: "Alpha", options: [first] },
      { label: "Beta", options: [middle] },
      { label: "Alpha", options: [last] },
    ]);
  });

  it("returns no groups for empty or omitted input", () => {
    expect(groupSelectOptions([])).toEqual([]);
    expect(groupSelectOptions(undefined)).toEqual([]);
  });
});
