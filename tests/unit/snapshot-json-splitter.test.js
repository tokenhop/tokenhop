// YAN-1013: byte-level snapshot JSON splitter. Correctness-critical, so this is
// heavy on boundary cases (chunking, multibyte UTF-8, escapes) plus a seeded
// equivalence fuzz against JSON.parse of the whole document.
import { describe, expect, it } from "vitest";
import {
  createSnapshotSplitter,
  readSnapshotHead,
  SNAPSHOT_JSON_INVALID,
} from "@/shared/utils/snapshotJsonSplitter.js";
import { DOC, chunkBytes, enc, split } from "../helpers/snapshotSplitterHelpers.js";

describe("snapshotJsonSplitter", () => {
  it("compact and pretty-printed (indent 2, CRLF, tabs) give identical results", () => {
    const expected = JSON.parse(JSON.stringify(DOC));
    const compact = JSON.stringify(DOC);
    const pretty2 = JSON.stringify(DOC, null, 2);
    const crlf = pretty2.replace(/\n/g, "\r\n");
    const tabs = JSON.stringify(DOC, null, "\t");
    for (const text of [compact, pretty2, crlf, tabs]) {
      for (const size of [1, 7, 64 * 1024]) {
        expect(split(text, { size }).out).toEqual(expected);
      }
    }
  });

  it("handles arbitrary key order, with sections before and after head keys", () => {
    const keys = Object.keys(DOC);
    for (const order of [
      keys,
      [...keys].reverse(),
      [keys[2], keys[0], keys[4], keys[1], keys[3], keys[5], keys[6], keys[7]],
    ]) {
      const doc = Object.fromEntries(order.map((k) => [k, DOC[k]]));
      expect(split(JSON.stringify(doc), { size: 5 }).out).toEqual(doc);
    }
  });

  it("is not fooled by structural characters inside strings", () => {
    const tricky = [
      '"',
      "\\",
      '\\"',
      "\\\\",
      "{",
      "[",
      "]",
      "}",
      ",",
      ":",
      "\u2028",
      "\u2029",
      "\\u0022",
      '"}]',
      "\\\\\\",
    ];
    const doc = {
      budgets: tricky.map((s, i) => ({ id: i, s })),
      note: tricky.join(""),
      [tricky.join("")]: "key-with-specials",
    };
    for (const size of [1, 3, 64 * 1024]) {
      expect(split(JSON.stringify(doc), { size }).out).toEqual(doc);
    }
  });

  it("emits exact value bytes (consumer decodes with fatal TextDecoder)", () => {
    const text = '  {\r\n "a" : "x" ,\n "budgets" : [ {"id":1} , 2 ,"s" ] }  ';
    const seen = [];
    const s = createSnapshotSplitter({
      streamedArrays: ["budgets"],
      onValue: (k, b) => seen.push([k, new TextDecoder().decode(b)]),
      onElement: (k, b) => seen.push([k, new TextDecoder().decode(b)]),
    });
    s.write(enc.encode(text));
    s.end();
    expect(seen).toEqual([
      ["a", '"x"'],
      ["budgets", '{"id":1}'],
      ["budgets", "2"],
      ["budgets", '"s"'],
    ]);
  });

  it("handles multibyte UTF-8 split across chunk boundaries (sizes 1, 7, 64K)", () => {
    const doc = {
      budgets: [{ id: "é€𝄞", s: "日本語🙂 \u2028 end" }],
      note: "ünï©ødé 𠜎",
      "ключ🙂": "значение",
    };
    const bytes = enc.encode(JSON.stringify(doc));
    for (const size of [1, 2, 3, 7, 64 * 1024]) {
      expect(split(bytes, { size }).out).toEqual(doc);
    }
  });

  it("emitted bytes of a split multibyte value stay a valid fatal-decodable text", () => {
    const doc = { note: "🙂🙂🙂", budgets: [{ id: "🙂" }] };
    const bytes = enc.encode(JSON.stringify(doc));
    const fatal = new TextDecoder("utf-8", { fatal: true });
    const s = createSnapshotSplitter({
      streamedArrays: ["budgets"],
      onValue: (_k, b) => fatal.decode(b),
      onElement: (_k, b) => fatal.decode(b),
    });
    for (const c of chunkBytes(bytes, 1)) s.write(c);
    s.end();
  });

  it("distinguishes an empty [] from an absent key", () => {
    const empty = split('{"budgets":[],"formatVersion":3}');
    expect(empty.events.starts).toEqual(["budgets"]);
    expect(empty.events.ends).toEqual(["budgets"]);
    expect(empty.out.budgets).toEqual([]);
    const absent = split('{"formatVersion":3}');
    expect(absent.events.starts).toEqual([]);
    expect("budgets" in absent.out).toBe(false);
    const spaced = split('{ "budgets" : [ \r\n ] }');
    expect(spaced.out.budgets).toEqual([]);
  });

  it("keeps nested objects/arrays inside elements intact", () => {
    const doc = { usageHistory: [{ a: { b: { c: [1, [2, [3, { d: "]" }]]] } } }, [[]], {}] };
    expect(split(JSON.stringify(doc), { size: 4 }).out).toEqual(doc);
  });

  it("emits a non-array value of a streamed key whole (the consumer rejects it)", () => {
    const { out, events } = split('{"budgets":{"id":1},"usageHistory":null,"requestDetails":"s"}');
    expect(out).toEqual({ budgets: { id: 1 }, usageHistory: null, requestDetails: "s" });
    expect(events.values).toEqual(["budgets", "usageHistory", "requestDetails"]);
    expect(events.starts).toEqual([]);
    expect(events.elements).toEqual([]);
  });

  it("accepts an empty object and tolerates a UTF-8 BOM", () => {
    expect(split("{}").out).toEqual({});
    expect(split(`\ufeff{"a":1}`, { size: 1 }).out).toEqual({ a: 1 });
    expect(split(" \r\n{ \n } \n").out).toEqual({});
  });

  it("scalars at chunk ends (numbers, true/false/null)", () => {
    const doc = {
      a: 123456789,
      b: -1.5e-7,
      c: true,
      d: false,
      e: null,
      budgets: [1, 22, true, null],
    };
    for (const size of [1, 2, 3, 64 * 1024])
      expect(split(JSON.stringify(doc), { size }).out).toEqual(doc);
  });

  describe("skip mode", () => {
    it("never calls onValue for skipped keys and does not retain their bytes", () => {
      const big = "x".repeat(2 * 1024 * 1024);
      const text = JSON.stringify({
        skipMe: { big, list: [big] },
        formatVersion: 3,
        alsoSkip: big,
        kept: "k",
      });
      const { events, out } = split(text, {
        size: 4096,
        streamed: [],
        keep: new Set(["formatVersion", "kept"]),
        maxKeptBytes: 1024,
        maxElementBytes: 1024,
      });
      expect(events.values).toEqual(["formatVersion", "kept"]);
      expect(out).toEqual({ formatVersion: 3, kept: "k" });
    });

    it("skipped values count toward neither head nor element caps but are still delimited", () => {
      const text = JSON.stringify({ a: "y".repeat(5000), b: 1 });
      expect(split(text, { keep: new Set(["b"]), maxKeptBytes: 64 }).out).toEqual({ b: 1 });
    });

    it("readSnapshotHead returns only the requested keys", async () => {
      const text = JSON.stringify({ ...DOC, formatVersion: 2 }, null, 2);
      const bytes = enc.encode(text);
      async function* gen() {
        for (const c of chunkBytes(bytes, 13)) yield c;
      }
      const head = await readSnapshotHead(gen(), {
        keys: ["formatVersion", "apiKeyStorage", "credentialEncryption", "nope"],
      });
      expect(head).toEqual({
        formatVersion: 2,
        apiKeyStorage: "hashed",
        credentialEncryption: DOC.credentialEncryption,
      });
      expect(Object.keys(head)).toEqual(["formatVersion", "apiKeyStorage", "credentialEncryption"]);
    });

    it("readSnapshotHead also accepts a web ReadableStream and rejects bad input", async () => {
      const bytes = enc.encode(JSON.stringify(DOC));
      const stream = new ReadableStream({
        start(controller) {
          for (const c of chunkBytes(bytes, 9)) controller.enqueue(c);
          controller.close();
        },
      });
      expect(await readSnapshotHead(stream, { keys: ["formatVersion"] })).toEqual({
        formatVersion: 3,
      });
      async function* truncated() {
        yield bytes.subarray(0, bytes.length - 3);
      }
      await expect(
        readSnapshotHead(truncated(), { keys: ["formatVersion"] }),
      ).rejects.toMatchObject({
        code: SNAPSHOT_JSON_INVALID,
        reason: "truncated",
      });
      await expect(readSnapshotHead(5, { keys: [] })).rejects.toThrow(TypeError);
    });

    it("readSnapshotHead does not let a __proto__ key pollute the result", async () => {
      async function* gen() {
        yield enc.encode('{"__proto__":{"polluted":1},"a":1}');
      }
      const head = await readSnapshotHead(gen(), { keys: ["__proto__", "a"] });
      expect(Object.getPrototypeOf(head)).toBe(Object.prototype);
      expect({}.polluted).toBeUndefined();
      expect(Object.keys(head)).toEqual(["__proto__", "a"]);
    });
  });
});
