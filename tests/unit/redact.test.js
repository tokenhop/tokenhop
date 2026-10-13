// YAN-378: shared dependency-free redactor (open-sse/utils/redact.js).
// Bounds: patterns must catch known token shapes and request-local secrets;
// token counts, Claude signatures and opaque non-secrets must survive.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  collectCredentialSecrets,
  isCredentialName,
  normalizeSecrets,
  redactDeep,
  redactText,
  sanitizeUrl,
} from "../../open-sse/utils/redact.js";

// Synthetic fixtures: provider-shaped tokens are assembled at runtime
// (join / repeat / digit runs) so source never holds a contiguous realistic
// credential literal. Runtime values equal the former literals exactly.
const JWT = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "eyJzdWIiOiJzZW50Mzc4LWJlYXJlciJ9",
  "sWq3r9xQ1nTlK0vZ8yHb2cD4eF6gA8iC0eU5oP7mN1s",
].join(".");
const digits = (n) => "1234567890".repeat(Math.ceil(n / 10)).slice(0, n);
const AIZA = ["AIza", "SyA-very-long-google-api-key-", digits(10)].join("");
const GITHUB_PAT = ["github", "pat", `11${"A".repeat(7)}0${"a".repeat(36)}`].join("_");
const XOXB = ["xoxb", digits(18)].join("-");
const XOXP = ["xoxp", digits(18)].join("-");
const AWS_AKIA = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
const YA29_SHORT = ["ya29", "a0ARrdaM"].join(".");
const YA29_LONG = `${YA29_SHORT}-long-secret`;
const GSK = ["gsk", digits(30)].join("_");
const XAI = ["xai", digits(20)].join("-");
const HF = ["hf", digits(20)].join("_");
const NVAPI = ["nvapi", digits(40)].join("-");

describe("redactText token patterns", () => {
  it("redacts sk-, th_, AIza, JWT, Bearer and common provider tokens", () => {
    const sk = ["sk", "sent378", "connkey", "9f41ba"].join("-");
    const th = ["th", "abcdefghijklmnopqrstuvwxyz012345"].join("_");
    const redacted = redactText(
      `${sk} ${th} ${AIZA} Bearer ${YA29_SHORT} ${JWT} ghp_${"a".repeat(36)} ${GITHUB_PAT} ${XOXB} ${AWS_AKIA} ${YA29_LONG} ${GSK} ${XAI} ${HF} ${NVAPI}`,
    );
    for (const secret of [
      sk,
      th,
      AIZA,
      YA29_SHORT,
      JWT,
      `ghp_${"a".repeat(36)}`,
      GITHUB_PAT,
      XOXB,
      AWS_AKIA,
      GSK,
      XAI,
      HF,
      NVAPI,
    ]) {
      assert.ok(!redacted.includes(secret), `leaked: ${secret}`);
    }
    assert.ok(redacted.includes("Bearer [REDACTED]"));
  });

  it("redacts tokens behind JSON/URL escapes without censoring subwords", () => {
    const skParts = ["sk", "sent378", "oauth", "access", "d20c77"];
    const sk = skParts.join("-");
    const cases = [
      `{"v":"\\n${sk}"}`,
      `{"v":"\\t${sk}"}`,
      `{"v":"\\u0022${sk}"}`,
      `%0A${sk}`,
      `%20${sk}`,
      `https://u.test/x?q=%22${sk}%22`,
      `{"j":"\\n${JWT}"}`,
      `%0A${JWT}`,
    ];
    for (const input of cases) {
      const out = redactText(input);
      assert.ok(!out.includes(sk), `sk escaped leak: ${input} -> ${out}`);
      assert.ok(!out.includes(JWT), `jwt escaped leak: ${input} -> ${out}`);
    }
    for (const benign of ["project-sk-learn-alpha", `x${sk}`, "mya29.example.com"]) {
      assert.ok(redactText(`see ${benign} now`).includes(benign), `censored: ${benign}`);
    }
  });

  it("masks complete dotted token runs and escaped provider shapes", () => {
    const skDotted = ["sk", "sent378", "connkey", "9f41ba"].join("-");
    const tokens = [
      `${JWT}.extraSecret42`,
      [`${skDotted}.opaque`, "Remainder42"].join(""),
      `gho_${"a".repeat(36)}`,
      `ghp_${"a".repeat(36)}`,
      `th_${"a".repeat(32)}`,
      `AIza${"a".repeat(35)}`,
      GITHUB_PAT,
      XOXB,
      XOXP,
      AWS_AKIA,
      YA29_LONG,
      GSK,
      XAI,
      HF,
      NVAPI,
    ];
    for (const token of tokens) {
      for (const prefix of ["", "\\n", "\\t", "\\u0022", "%0A", "%20"]) {
        assert.equal(redactText(prefix + token), `${prefix}[REDACTED]`);
      }
    }
    for (const benign of [
      "ghp_docs",
      "gho_sample",
      "github_pat_example",
      "hf_model",
      "xai-guide",
      "nvapi-docs",
      "AKIA_example",
      "ya29.example",
      "gsk_short",
      "xoxb-docs",
    ]) {
      assert.equal(redactText(benign), benign);
    }
  });

  // Source-backed provider forms: [label, token]. Heuristic/variable formats.
  const A = (n, c = "a") => c.repeat(n);
  const PROVIDER_FORMS = [
    ["ghp min", `ghp_${A(36)}`],
    ["ghp max", `ghp_${A(251)}`],
    ["gho", `gho_${A(36)}`],
    ["ghu", `ghu_${A(40)}`],
    ["ghr", `ghr_${A(36)}`],
    ["ghs classic", `ghs_${A(36)}`],
    ["ghs JWT dotted ~520", `ghs_${`${A(40)}.${A(40)}.`.repeat(4)}${A(200)}`],
    ["github_pat min", `github_pat_${A(40)}`],
    ["github_pat max", `github_pat_${A(40)}_${A(203)}`],
    ["slack xoxb", `xoxb-${A(10)}`],
    ["slack xoxa", `xoxa-123-${A(10)}`],
    ["slack xoxp", ["xoxp", digits(10), A(12)].join("-")],
    ["slack xoxr", `xoxr-${A(12)}`],
    ["slack xoxs", `xoxs-${A(12)}`],
    ["slack xapp", `xapp-1-A0123-${A(12)}`],
    ["slack xoxe rotated", `xoxe-1-${A(30)}`],
    ["slack xoxe.xoxb", `xoxe.xoxb-1-${A(30)}`],
    ["slack xoxe.xoxp", `xoxe.xoxp-1-${A(30)}`],
    ["slack xoxe.xapp", `xoxe.xapp-1-${A(30)}`],
    ["aws AKIA", ["AKIA", digits(10), "ABCDEF"].join("")],
    ["aws ASIA", ["ASIA", digits(10), "ABCDEF"].join("")],
    ["google ya29", `ya29.${A(20)}`],
    ["google ya29 long", `ya29.a0${A(40)}-_.${A(40)}`],
    ["groq", `gsk_${A(30)}`],
    ["xai", `xai-${A(20)}`],
    ["xai mgmt", `xai-mgmt-${A(20)}`],
    ["hf", `hf_${A(20)}`],
    ["hf jwt", `hf_jwt_${A(20)}`],
    ["hf oauth", `hf_oauth_${A(20)}`],
    ["nvidia", `nvapi-${A(40)}`],
  ];

  it("masks every source-backed provider form whole, incl. escape prefixes", () => {
    for (const [label, token] of PROVIDER_FORMS) {
      for (const prefix of ["", "\\n", "\\t", "\\u0022", "%0A", "%20"]) {
        assert.equal(redactText(prefix + token), `${prefix}[REDACTED]`, label);
        const embedded = redactText(`key: ${prefix}${token} end`);
        assert.equal(embedded, `key: ${prefix}[REDACTED] end`, `${label} embedded`);
      }
    }
  });

  it("keeps short, wrong-boundary and wrong-charset provider look-alikes", () => {
    for (const benign of [
      `ghp_${A(35)}`, // below floor
      `ghp_${A(35)}_x`, // underscore is not in ghp body
      `ghs_${A(35)}`,
      `github_pat_${A(39)}`,
      `xoxb-${A(9)}`,
      ["xoxz", digits(13)].join("-"),
      `xapp-${A(9)}`,
      "xoxe-short",
      ["xoxe", ["xoxz", "1", `0${digits(9)}abcdef`].join("-")].join("."),
      ["AKIA", digits(10), "ABCDE"].join(""), // 15 body chars
      ["AKIA", digits(10), "abcdef"].join(""), // lower-case body
      ["ASIA", digits(10), "ABCDE"].join(""),
      `ya29.${A(19)}`,
      `gsk_${A(29)}`,
      `xai-${A(19)}`,
      `xai-mgmt-${A(10)}`,
      `hf_${A(19)}`,
      `hf_jwt_${A(19)}`,
      `nvapi-${A(39)}`,
      `x${`ghp_${A(36)}`}`, // glued to prose: documented ceiling, not censored
    ]) {
      assert.equal(redactText(`see ${benign} now`), `see ${benign} now`, benign);
    }
  });

  it("keeps non-secrets: max_tokens, signatures, sk-learn-project-alpha, opaque ids", () => {
    const text =
      "max_tokens=4096 prompt_tokens 12 thinking.budget_tokens sk-learn-project-alpha " +
      "signature: EqoBCkgIABICGAJAAkACAA key sha256:9f86d081884c7d659a2feaa0c55ad015";
    assert.equal(redactText(text), text);
  });

  it("replaces exact request-local secrets of any shape", () => {
    const out = redactText("failed with opaque-key-1a2b3c-XYZ", ["opaque-key-1a2b3c-XYZ"]);
    assert.ok(!out.includes("opaque-key"));
  });

  it("redacts secrets mid-prose without touching surrounding words", () => {
    const out = redactText(`key ${"sk-ant-api03-".padEnd(40, "x7")} end`);
    assert.match(out, /^key \[REDACTED\] end$/);
  });

  it("normalizes known secrets with JSON and URL representations", () => {
    const secret = 'ab/c+d=e"f\\g 12345';
    const forms = [
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
      encodeURIComponent(secret).toLowerCase(),
      encodeURIComponent(secret).replace(/%20/g, "+"),
    ];
    const secrets = normalizeSecrets([secret, "short"]);
    for (const form of forms) assert.equal(redactText(`x ${form} y`, secrets), "x [REDACTED] y");
  });

  it("masks token-like Bearer values only, not ordinary prose", () => {
    assert.equal(redactText(`Authorization: Bearer ${JWT}`), "Authorization: Bearer [REDACTED]");
    assert.equal(redactText("Bearer opaque1token2"), "Bearer [REDACTED]");
    assert.equal(redactText("Bearer abc.def-ghi"), "Bearer [REDACTED]");
    for (const prose of [
      "Bearer authentication is used here",
      "send a Bearer credential to the server",
      "Bearer tokens are described below",
    ]) {
      assert.equal(redactText(prose), prose);
    }
  });

  it("returns short/non-string input unchanged", () => {
    assert.equal(redactText("short"), "short");
    assert.equal(redactText(undefined), undefined);
  });

  it("scans 1MB adversarial sk-/JWT/Bearer text within a generous bound", () => {
    const malformed = `${"sk-".repeat(120000)} ${"eyJbad.bad.".repeat(60000)} ${"Bearer x ".repeat(6000)}`;
    const input = `${malformed} ${JWT} sk-sent378-connkey-9f41ba Bearer opaque1credential`;
    assert.ok(input.length >= 1000000);
    const started = process.hrtime.bigint();
    const out = redactText(input);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(out, `${malformed} [REDACTED] [REDACTED] Bearer [REDACTED]`);
    assert.ok(elapsedMs <= 1000, `1MB scan took ${elapsedMs}ms`);
  });
});

describe("isCredentialName", () => {
  it("matches credential keys", () => {
    for (const k of [
      "apiKey",
      "api_key",
      "accessToken",
      "refreshToken",
      "idToken",
      "token",
      "session_token",
      "copilotToken",
      "authToken",
      "apiToken",
      "bearerToken",
      "sessionToken",
      "secretKey",
      "accessKey",
      "secretAccessKey",
      "secret",
      "clientSecret",
      "password",
      "passwd",
      "authorization",
      "cookie",
      "privateKey",
      "credential",
      "credentials",
    ]) {
      assert.ok(isCredentialName(k), `should mask ${k}`);
    }
  });

  it("does not match counts, signatures or bare key/tokens", () => {
    for (const k of [
      "max_tokens",
      "maxTokens",
      "promptTokens",
      "prompt_tokens",
      "budget_tokens",
      "thinking.budget_tokens",
      "signature",
      "key",
      "keys",
      "tokens",
      "model",
      "usage",
    ]) {
      assert.ok(!isCredentialName(k), `should keep ${k}`);
    }
  });
});

describe("collectCredentialSecrets", () => {
  it("collects credential-named leaves recursively, not metadata", () => {
    const secrets = collectCredentialSecrets({
      apiKey: "api-key-value-111",
      accessToken: "access-token-value-222",
      model: "gpt-4o-mini-long",
      connectionName: "Team Connection",
      email: "owner@example.test",
      rawHeaders: { authorization: "Bearer header-value-333" },
      providerSpecificData: {
        cookie: "psd-cookie-value-444",
        session: "psd-session-value-555",
        basic: "dXNlcjpwYXNzd29yZA==",
        region: "us-east-1",
        nested: { clientSecret: "nested-secret-value-666", label: "plain label here" },
      },
    });
    for (const v of [
      "api-key-value-111",
      "access-token-value-222",
      "psd-cookie-value-444",
      "psd-session-value-555",
      "dXNlcjpwYXNzd29yZA==",
      "nested-secret-value-666",
    ])
      assert.ok(secrets.includes(v), `missing ${v}`);
    for (const v of [
      "gpt-4o-mini-long",
      "Team Connection",
      "owner@example.test",
      "us-east-1",
      "plain label here",
      "Bearer header-value-333",
    ])
      assert.ok(!secrets.includes(v), `unexpected ${v}`);
  });

  it("is bounded and never throws on cycles or hostile getters", () => {
    const cyc = { providerSpecificData: {} };
    cyc.providerSpecificData.apiKey = "cycle-key-value-777";
    cyc.providerSpecificData.self = cyc;
    Object.defineProperty(cyc, "token", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    assert.deepEqual(collectCredentialSecrets(cyc), ["cycle-key-value-777"]);
    const wide = {};
    for (let i = 0; i < 200; i++) wide[`apiKey${i}`] = `wide-secret-value-${i}`;
    assert.ok(collectCredentialSecrets(wide).length <= 32);
    assert.deepEqual(collectCredentialSecrets(null), []);
  });
});

describe("redactDeep", () => {
  it("returns a copy, masks credential names, redacts text leaves", () => {
    const input = {
      model: "gpt-x",
      apiKey: "sk-sent378-gwkey-774afd",
      providerSpecificData: { apiKey: "opaque" },
      authorization: "Bearer abc123def456",
      nested: { message: `has ${JWT}` },
      max_tokens: 4096,
    };
    const out = redactDeep(input);
    assert.notEqual(out, input);
    assert.equal(input.apiKey, "sk-sent378-gwkey-774afd"); // input untouched
    assert.equal(out.apiKey, "[REDACTED]");
    assert.equal(out.providerSpecificData.apiKey, "[REDACTED]");
    assert.equal(out.authorization, "[REDACTED]");
    assert.ok(!out.nested.message.includes(JWT));
    assert.equal(out.max_tokens, 4096);
  });

  it("handles cycles, deep chains, class instances and getters", () => {
    const obj = { name: `token ${JWT}` };
    obj.self = obj;
    const out = redactDeep(obj);
    assert.equal(out.self, "[Circular]");
    assert.ok(!out.name.includes(JWT));

    let deep = { val: 1 };
    for (let i = 0; i < 30; i++) deep = { next: deep };
    assert.ok(JSON.stringify(redactDeep(deep)).includes("[Truncated]"));

    class C {
      value = ["sk", "sent378", "password", "0d3b62"].join("-");
    }
    assert.ok(JSON.stringify(redactDeep(new C())).includes("[REDACTED]"));

    const hostile = Object.defineProperty({}, "apiKey", {
      get() {
        throw new Error("boom");
      },
      enumerable: true,
    });
    assert.doesNotThrow(() => redactDeep(hostile));
  });

  it("sanitizes nested absolute and protocol-relative URL strings, not prose", () => {
    const opaque = "opaque-nested-key-ZZ99";
    const out = redactDeep(
      {
        a: { url: `https://u:pw1234@h.test/v1?key=${opaque}&alt=sse` },
        b: [`//cdn.test/x?authToken=tokvalue99&q=1`],
        c: "see https://h.test/v1?key=plainprose in prose",
        d: "discuss key=token values",
      },
      { secrets: [opaque] },
    );
    assert.ok(!JSON.stringify(out.a).includes("pw1234"));
    assert.ok(!JSON.stringify(out.a).includes(opaque));
    assert.ok(out.a.url.includes("alt=sse"));
    assert.ok(!out.b[0].includes("tokvalue99"));
    assert.ok(out.b[0].includes("q=1"));
    assert.equal(out.d, "discuss key=token values");
    // Embedded-in-prose URL is not a strict URL leaf: only token shapes/provenance apply.
    assert.equal(out.c, "see https://h.test/v1?key=plainprose in prose");
  });

  it("a hostile Error getter drops only that property", () => {
    const err = new Error(`failed ${JWT}`);
    Object.defineProperty(err, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter boom");
      },
    });
    err.detail = `has ${JWT}`;
    err.apiKey = "sk-sent378-gwkey-774afd";
    let out;
    assert.doesNotThrow(() => {
      out = redactDeep(err);
    });
    assert.ok(!JSON.stringify(out).includes(JWT));
    assert.equal(out.apiKey, "[REDACTED]");
    assert.ok(typeof out.message === "string" && out.message.includes("[REDACTED]"));
    assert.ok(!("boom" in out));
  });

  it("caps very large structures without throwing", () => {
    const big = Array.from({ length: 60000 }, (_, i) => ({ i }));
    const out = redactDeep(big);
    assert.ok(out.length > 0 && out.some((v) => v === "[Truncated]"));
  });
});

describe("sanitizeUrl", () => {
  it("masks credential query params and userinfo, keeps benign ones", () => {
    const out = sanitizeUrl(
      "https://user:secretpw@upstream.test/v1/models?key=abc123def456&token=tok_1234567890&alt=sse#sig=abcdef123456",
    );
    assert.ok(!out.includes("secretpw"));
    assert.ok(!out.includes("abc123def456"));
    assert.ok(!out.includes("tok_1234567890"));
    assert.ok(!out.includes("abcdef123456"));
    assert.ok(out.includes("upstream.test/v1/models"));
    assert.ok(out.includes("alt=sse"));
  });

  it("masks greedy userinfo containing @ and semicolon-separated params", () => {
    const out = sanitizeUrl(
      "https://user:p@ss@h.test/v1?alt=sse;api_key=semi123456;copilotToken=tok123456",
    );
    assert.ok(!out.includes("p@ss"));
    assert.ok(!out.includes("semi123456"));
    assert.ok(!out.includes("tok123456"));
    assert.ok(out.startsWith("https://REDACTED@h.test/v1"));
  });

  it("returns non-URL prose unchanged", () => {
    const prose = "discuss key=token values in chat prose";
    assert.equal(sanitizeUrl(prose), redactText(prose));
  });
});
