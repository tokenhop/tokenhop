// YAN-1013: byte-level snapshot JSON splitter. Correctness-critical, so this is
// heavy on boundary cases (chunking, multibyte UTF-8, escapes) plus a seeded
// equivalence fuzz against JSON.parse of the whole document.
import { describe, expect, it } from "vitest";
import {
  createSnapshotSplitter,
  parseSnapshotValue,
  readSnapshotHead,
  SNAPSHOT_JSON_INVALID,
} from "@/shared/utils/snapshotJsonSplitter.js";

const enc = new TextEncoder();
const SECTIONS = ["budgets", "usageHistory", "requestDetails"];

function chunkBytes(bytes, size) {
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

// Runs the splitter and re-assembles a plain object like a consumer would.
function split(input, { size = 64 * 1024, streamed = SECTIONS, keep, ...limits } = {}) {
  const bytes = typeof input === "string" ? enc.encode(input) : input;
  const out = {};
  const events = { values: [], elements: [], starts: [], ends: [] };
  const splitter = createSnapshotSplitter({
    streamedArrays: new Set(streamed),
    keepKey: keep ? (k) => keep.has(k) : undefined,
    onValue(k, b) {
      events.values.push(k);
      out[k] = parseSnapshotValue(b);
    },
    onElement(k, b) {
      events.elements.push(k);
      out[k].push(parseSnapshotValue(b));
    },
    onArrayStart(k) {
      events.starts.push(k);
      out[k] = [];
    },
    onArrayEnd(k) {
      events.ends.push(k);
    },
    ...limits,
  });
  for (const c of chunkBytes(bytes, size)) splitter.write(c);
  splitter.end();
  return { out, events };
}

function expectInvalid(fn, reason) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err, "expected the splitter to throw").toBeTruthy();
  expect(err.code).toBe(SNAPSHOT_JSON_INVALID);
  if (reason) expect(err.reason).toBe(reason);
}

const DOC = {
  formatVersion: 3,
  apiKeyStorage: "hashed",
  budgets: [
    { id: "b1", note: 'q"uo\\te' },
    { id: "b2", n: [1, { a: null }] },
  ],
  credentialEncryption: { version: 1, nested: { deep: [true, false, "x]}"] } },
  usageHistory: [],
  kv: { "weird}key": "v{al[", arr: [[], {}] },
  requestDetails: [{ id: 1, data: "x" }],
  trailing: 12.5e3,
};

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

  describe("equivalence fuzz", () => {
    function mulberry32(seed) {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const ALPHABET = [
      "a",
      "Z",
      "0",
      " ",
      '"',
      "\\",
      "{",
      "}",
      "[",
      "]",
      ",",
      ":",
      "\n",
      "\t",
      "\r",
      "/",
      "é",
      "€",
      "日",
      "🙂",
      "𝄞",
      "\u2028",
      "\u2029",
      "\u0000",
      "\u001f",
    ];

    function genDoc(rnd) {
      const int = (n) => Math.floor(rnd() * n);
      const pick = (arr) => arr[int(arr.length)];
      const str = () => {
        const len = int(14);
        let s = "";
        for (let i = 0; i < len; i++) s += pick(ALPHABET);
        if (rnd() < 0.03) s += "\ud800"; // lone surrogate, serialised as an escape
        return s;
      };
      const scalar = () => {
        const r = rnd();
        if (r < 0.35) return str();
        if (r < 0.55) return int(1e9) * (rnd() < 0.5 ? -1 : 1);
        if (r < 0.7) return rnd() * 1e6;
        if (r < 0.8) return Number((rnd() * 1e-9).toPrecision(3));
        if (r < 0.9) return rnd() < 0.5;
        return null;
      };
      const value = (d) => {
        if (d >= 4 || rnd() < 0.5) return scalar();
        if (rnd() < 0.5) return Array.from({ length: int(4) }, () => value(d + 1));
        const o = {};
        for (let i = int(4); i > 0; i--) o[str() || "k"] = value(d + 1);
        return o;
      };
      const doc = {};
      const keys = [
        "formatVersion",
        "schemaVersion",
        "apiKeyStorage",
        "credentialEncryption",
        "workspaceKeys",
        "kv",
        "providerConnections",
        "combos",
        ...SECTIONS,
      ];
      for (let i = keys.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [keys[i], keys[j]] = [keys[j], keys[i]];
      }
      for (const k of keys) {
        if (rnd() < 0.15) continue; // absent
        if (SECTIONS.includes(k)) {
          const r = rnd();
          if (r < 0.1) doc[k] = [];
          else if (r < 0.15)
            doc[k] = value(0); // sometimes a non-array
          else
            doc[k] = Array.from({ length: int(12) }, () =>
              rnd() < 0.8 ? { id: int(1e6), v: value(0), s: str() } : value(0),
            );
        } else doc[k] = value(0);
      }
      for (let i = int(3); i > 0; i--) doc[`extra${i}${str()}`] = value(0);
      return doc;
    }

    function render(rnd, doc) {
      const r = rnd();
      let text;
      if (r < 0.4) text = JSON.stringify(doc);
      else if (r < 0.7) text = JSON.stringify(doc, null, 2);
      else if (r < 0.85) text = JSON.stringify(doc, null, "\t");
      else text = JSON.stringify(doc, null, 2).replace(/\n/g, "\r\n");
      if (rnd() < 0.3) text = ` \r\n${text}\n `;
      return enc.encode(text);
    }

    function randomChunks(rnd, bytes) {
      const mode = rnd();
      const out = [];
      let i = 0;
      while (i < bytes.length) {
        const size =
          mode < 0.3
            ? 1
            : mode < 0.6
              ? 1 + Math.floor(rnd() * 8)
              : mode < 0.85
                ? 1 + Math.floor(rnd() * 300)
                : 64 * 1024;
        out.push(bytes.subarray(i, i + size));
        i += size;
      }
      return out;
    }

    it("200 seeded random documents re-assemble to JSON.parse(whole)", () => {
      for (let seed = 1; seed <= 200; seed++) {
        const rnd = mulberry32(seed * 7919);
        const doc = genDoc(rnd);
        const bytes = render(rnd, doc);
        const expected = JSON.parse(new TextDecoder().decode(bytes));

        const got = {};
        const s = createSnapshotSplitter({
          streamedArrays: new Set(SECTIONS),
          onValue(k, b) {
            got[k] = parseSnapshotValue(b);
          },
          onArrayStart(k) {
            got[k] = [];
          },
          onElement(k, b) {
            got[k].push(parseSnapshotValue(b));
          },
        });
        for (const c of randomChunks(rnd, bytes)) s.write(c);
        s.end();
        expect(got, `seed ${seed}`).toEqual(expected);
        // Key order of the assembled object matches the document order.
        expect(Object.keys(got), `seed ${seed} key order`).toEqual(Object.keys(expected));

        // Skip mode over the same document: only the requested keys, same values.
        const want = new Set(Object.keys(expected).filter((_, i) => i % 3 === 0));
        const skipped = {};
        const calls = [];
        const s2 = createSnapshotSplitter({
          keepKey: (k) => want.has(k),
          onValue(k, b) {
            calls.push(k);
            skipped[k] = parseSnapshotValue(b);
          },
        });
        for (const c of randomChunks(rnd, bytes)) s2.write(c);
        s2.end();
        expect(skipped, `seed ${seed} skip`).toEqual(
          Object.fromEntries([...want].map((k) => [k, expected[k]])),
        );
        expect(new Set(calls).size).toBe(calls.length);
      }
    });

    it("every truncation point of a fuzz document is rejected (never silently accepted)", () => {
      const rnd = mulberry32(424242);
      const doc = genDoc(rnd);
      const bytes = enc.encode(JSON.stringify(doc));
      const step = Math.max(1, Math.floor(bytes.length / 150));
      for (let cut = 0; cut < bytes.length; cut += step) {
        // A cut that leaves a still-complete document is impossible: the closing
        // brace is the final byte, so every strict prefix must fail.
        expect(() => split(bytes.subarray(0, cut), { size: 31 }), `cut ${cut}`).toThrow();
      }
    });
  });
});
