// YAN-1013: malformed-input and limit cases of the snapshot JSON splitter
// (split from snapshot-json-splitter.test.js).
import { describe, expect, it } from "vitest";
import { createSnapshotSplitter } from "@/shared/utils/snapshotJsonSplitter.js";
import { enc, expectInvalid, split } from "../helpers/snapshotSplitterHelpers.js";

describe("snapshotJsonSplitter", () => {
  describe("malformed input fails with SNAPSHOT_JSON_INVALID", () => {
    const sizes = [1, 64 * 1024];
    const bad = (label, text, reason) =>
      it(label, () => {
        for (const size of sizes) expectInvalid(() => split(text, { size }), reason);
      });

    bad("top-level array", '[{"a":1}]', "not_object");
    bad("top-level scalar", "42", "not_object");
    bad("top-level string", '"x"', "not_object");
    bad("empty input", "", "truncated");
    bad("whitespace-only input", "  \n", "truncated");
    bad("truncated inside a string value", '{"a":"abc', "truncated");
    bad("truncated inside an element", '{"budgets":[{"id":1},{"id":', "truncated");
    bad("truncated after an element", '{"budgets":[{"id":1}', "truncated");
    bad("truncated in the head", '{"formatVersion":3,"a":{"b":[1,2', "truncated");
    bad("truncated inside a key", '{"formatVe', "truncated");
    bad("truncated after a scalar", '{"a":12', "truncated");
    bad("truncated after the colon", '{"a":', "truncated");
    bad("missing closing brace", '{"a":1,', "truncated");
    bad("trailing garbage", '{"a":1} x', "trailing");
    bad("trailing second object", '{"a":1}{"b":2}', "trailing");
    bad("duplicate top-level key", '{"a":1,"b":2,"a":3}', "duplicate_key");
    bad("duplicate key written with an escape", '{"a":1,"\\u0061":3}', "duplicate_key");
    bad("duplicate streamed section", '{"budgets":[],"budgets":[]}', "duplicate_key");
    bad(
      "duplicate key inside skipped values still counted at top level",
      '{"a":{"x":1,"x":2},"b":1,"b":2}',
      "duplicate_key",
    );
    bad("missing comma between members", '{"a":1 "b":2}', "syntax");
    bad("missing comma between elements", '{"budgets":[1 2]}', "syntax");
    bad("trailing comma in elements", '{"budgets":[1,]}', "syntax");
    bad("leading comma in elements", '{"budgets":[,1]}', "syntax");
    bad("trailing comma in object", '{"a":1,}', "syntax");
    bad("missing colon", '{"a" 1}', "syntax");
    bad("empty value", '{"a":}', "syntax");
    bad("non-string key", "{1:2}", "syntax");
    bad("unquoted-key garbage", "{a:1}", "syntax");

    it("an oversized element (maxElementBytes)", () => {
      const text = JSON.stringify({ budgets: [{ id: 1 }, { id: 2, pad: "z".repeat(500) }] });
      for (const size of sizes)
        expectInvalid(() => split(text, { size, maxElementBytes: 100 }), "element_too_large");
      expect(split(text, { maxElementBytes: 1000 }).out.budgets).toHaveLength(2);
    });

    it("an oversized element is rejected before the whole element is buffered", () => {
      let written = 0;
      const s = createSnapshotSplitter({
        streamedArrays: ["budgets"],
        maxElementBytes: 1000,
        onElement() {},
      });
      s.write(enc.encode('{"budgets":["'));
      const chunk = enc.encode("q".repeat(900));
      expect(() => {
        for (let i = 0; i < 100; i++) {
          s.write(chunk);
          written += chunk.length;
        }
      }).toThrow(/too large/);
      expect(written).toBeLessThan(5000);
    });

    it("a head that is too large (maxKeptBytes)", () => {
      const text = JSON.stringify({ a: "1".repeat(300), b: "2".repeat(300) });
      for (const size of sizes)
        expectInvalid(() => split(text, { size, maxKeptBytes: 400 }), "head_too_large");
      expect(split(text, { maxKeptBytes: 1000 }).out.a).toHaveLength(300);
    });

    it("a head whose total is too large through many small values (incl. key names)", () => {
      const doc = Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [`key${i}`, "v".repeat(20)]),
      );
      expectInvalid(
        () => split(JSON.stringify(doc), { maxKeptBytes: 500, size: 3 }),
        "head_too_large",
      );
    });

    it("streamed elements do not count toward the head cap", () => {
      const doc = {
        budgets: Array.from({ length: 200 }, (_, i) => ({ id: i, pad: "p".repeat(50) })),
      };
      expect(
        split(JSON.stringify(doc), { maxKeptBytes: 200, maxElementBytes: 200 }).out.budgets,
      ).toHaveLength(200);
    });

    it("invalid UTF-8 in a kept value is rejected by the consumer's fatal decode", () => {
      const head = enc.encode('{"a":"');
      const tail = enc.encode('"}');
      const bytes = new Uint8Array([...head, 0xc3, 0x28, ...tail]);
      expectInvalid(() => split(bytes), "utf8");
    });

    it("a key that is not valid JSON text is rejected", () => {
      expectInvalid(() => split('{"a\\q":1}'), "syntax");
    });

    it("stays failed after an error and refuses end()", () => {
      const s = createSnapshotSplitter({});
      expect(() => s.write(enc.encode("[1]"))).toThrow();
      expect(() => s.write(enc.encode("{}"))).toThrow();
      expect(() => s.end()).toThrow();
    });

    it("rejects non-binary chunks", () => {
      expect(() => createSnapshotSplitter({}).write("{}")).toThrow(TypeError);
    });
  });
});
