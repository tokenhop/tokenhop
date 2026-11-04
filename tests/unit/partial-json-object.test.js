// parsePartialJSONObject: tool arguments cut off by max_tokens keep only the
// values that finished (YAN-1854).
import { describe, expect, it } from "vitest";

const { parsePartialJSONObject } = await import("../../open-sse/translator/concerns/json.js");

describe("parsePartialJSONObject", () => {
  it.each([
    ["complete object", '{"a":1}', { a: 1 }],
    ["cut string value", '{"a":1,"b":"x', { a: 1 }],
    ["escaped quote", '{"s":"a\\"b","t":"x', { s: 'a"b' }],
    ["escaped backslash before close", '{"s":"a\\\\","t":"x', { s: "a\\" }],
    ["cut inside \\u escape", '{"a":1,"s":"\\u12', { a: 1 }],
    ["cut true literal", '{"a":1,"b":tru', { a: 1 }],
    ["cut null literal", '{"a":1,"b":nul', { a: 1 }],
    ["finished literal at cut", '{"b":true', { b: true }],
    ["number at the cut is dropped", '{"a":1,"n":12', { a: 1 }],
    ["number followed by whitespace", '{"n":12 ', { n: 12 }],
    ["number followed by comma", '{"n":12,', { n: 12 }],
    ["nested array", '{"a":[1,2', { a: [1] }],
    ["nested object", '{"a":{"b":1,"c":"x', { a: { b: 1 } }],
    ["trailing comma", '{"a":1,', { a: 1 }],
    ["pending key without value", '{"a":1,"b":', { a: 1 }],
    ["cut key", '{"a":1,"qu', { a: 1 }],
    ["top-level array", "[1,2", {}],
    ["top-level string", '"str"', {}],
    ["empty text", "", {}],
  ])("%s", (_name, text, expected) => {
    expect(parsePartialJSONObject(text)).toEqual(expected);
  });

  it("keeps __proto__ as an own key without polluting prototypes", () => {
    const out = parsePartialJSONObject('{"__proto__":{"polluted":1},"b":"x');
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect({}.polluted).toBeUndefined();
  });

  it("bounds nesting depth and keeps what finished above the cap", () => {
    const deep = `{"a":1,"d":${"[".repeat(10_000)}`;
    const start = performance.now();
    expect(parsePartialJSONObject(deep)).toMatchObject({ a: 1 });
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("stays linear on long truncated input", () => {
    const text = `{${Array.from({ length: 20_000 }, (_, i) => `"k${i}":[{"v":${i}}]`).join(",")},"x":"cut`;
    const start = performance.now();
    const out = parsePartialJSONObject(text);
    expect(Object.keys(out)).toHaveLength(20_000);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
