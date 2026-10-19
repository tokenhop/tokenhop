// YAN-1013: seeded equivalence fuzz of the snapshot JSON splitter against
// JSON.parse (split from snapshot-json-splitter.test.js).
import { describe, expect, it } from "vitest";
import { createSnapshotSplitter, parseSnapshotValue } from "@/shared/utils/snapshotJsonSplitter.js";
import { SECTIONS, enc, split } from "../helpers/snapshotSplitterHelpers.js";

describe("snapshotJsonSplitter", () => {
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
