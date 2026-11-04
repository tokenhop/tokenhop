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
    ["valid exponent number", '{"n":-1.5e+3,"b":"x', { n: -1500 }],
    ["malformed number keeps earlier values", '{"a":1,"n":1-2,"b":2', { a: 1 }],
    ["leading zero is malformed", '{"a":1,"n":01,"b":2', { a: 1 }],
    ["lone minus is malformed", '{"a":1,"n":-,"b":2', { a: 1 }],
    ["empty text", "", {}],
    // YAN-1926: a container opened at the cut with no finished entries is
    // dropped with its key; containers keep their finished elements.
    ["empty array at the cut", '{"a":[', {}],
    ["empty array after a finished value", '{"a":1,"b":[', { a: 1 }],
    ["nested empty containers at the cut", '{"a":{"b":[', {}],
    ["finished empty object before a cut array", '{"a":{},"b":[', { a: {} }],
    ["closed empty array at the cut", '{"a":[]', { a: [] }],
    ["finished inner array before a cut one", '{"a":[[1],[', { a: [[1]] }],
    ["cut number inside an array", '{"a":[1', {}],
    ["empty object inside a cut array", '{"a":[{', {}],
    ["nested empty array after a finished value", '{"a":1,"b":{"c":[', { a: 1 }],
    // Text after the top-level object closes is ignored.
    ["second object after the first closes", '{"a":1}{"b":2', { a: 1 }],
    ["complete second object after the first", '{"a":1}{"b":2}', { a: 1 }],
    ["stray closer after the object", '{"a":1}]', { a: 1 }],
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
    expect(parsePartialJSONObject(deep)).toEqual({ a: 1 });
  });

  it("handles long truncated input", () => {
    const text = `{${Array.from({ length: 20_000 }, (_, i) => `"k${i}":[{"v":${i}}]`).join(",")},"x":"cut`;
    const out = parsePartialJSONObject(text);
    expect(Object.keys(out)).toHaveLength(20_000);
    expect(out.k19999).toEqual([{ v: 19_999 }]);
  });
});
