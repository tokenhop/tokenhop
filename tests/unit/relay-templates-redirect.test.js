// YAN-1598: each deployed relay template must honor the redirect mode the
// gateway forwards in x-relay-redirect. Evaluates the real template strings
// against a local upstream that 302s to a second local server: with
// x-relay-redirect: "error" the 302 is returned unfollowed (second server
// sees nothing); without the header the redirect is followed.
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLOUDFLARE_RELAY_CODE,
  DENO_RELAY_CODE,
  VERCEL_RELAY_CODE,
  RELAY_TEMPLATE_VERSION_HEADER,
} from "@/lib/network/relayTemplates";

let targetHits = 0;
let upstream;
let target;
let upstreamOrigin;
let targetOrigin;

beforeAll(async () => {
  target = createServer((_req, res) => {
    targetHits += 1;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("final");
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  targetOrigin = `http://127.0.0.1:${target.address().port}`;

  upstream = createServer((_req, res) => {
    res.writeHead(302, { location: `${targetOrigin}/final` });
    res.end();
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
});

afterAll(async () => {
  await Promise.all([new Promise((r) => upstream.close(r)), new Promise((r) => target.close(r))]);
});

function relayRequest(headers) {
  return new Request("http://relay.local/forward", { headers });
}

async function loadHandlers() {
  // Data-URL imports are cached per URL, so vary the source on each load
  // (the Deno stub must run again to capture its handler).
  loadHandlers.n = (loadHandlers.n || 0) + 1;
  const importCode = (code) =>
    import(`data:text/javascript,${encodeURIComponent(`${code}\n// load ${loadHandlers.n}`)}`);
  const vercel = await importCode(VERCEL_RELAY_CODE);
  const cloudflare = await importCode(CLOUDFLARE_RELAY_CODE);

  let denoHandler;
  const prevDeno = globalThis.Deno;
  globalThis.Deno = {
    serve: (fn) => {
      denoHandler = fn;
    },
  };
  try {
    await importCode(DENO_RELAY_CODE);
  } finally {
    if (prevDeno === undefined) delete globalThis.Deno;
    else globalThis.Deno = prevDeno;
  }

  return [
    ["vercel", (req) => vercel.default(req)],
    ["cloudflare", (req) => cloudflare.default.fetch(req)],
    ["deno", denoHandler],
  ];
}

describe("relay templates identify their deployed version", () => {
  it("adds the current version to success, redirect and local error responses", async () => {
    for (const [name, handler] of await loadHandlers()) {
      const missingTarget = await handler(relayRequest());
      expect(missingTarget.status, name).toBe(400);
      expect(missingTarget.headers.get(RELAY_TEMPLATE_VERSION_HEADER), name).toBe("2");

      for (const redirect of ["error", "follow"]) {
        const res = await handler(
          relayRequest({
            "x-relay-target": upstreamOrigin,
            "x-relay-path": "/poll",
            ...(redirect === "error" ? { "x-relay-redirect": redirect } : {}),
          }),
        );
        expect(res.headers.get(RELAY_TEMPLATE_VERSION_HEADER), `${name}/${redirect}`).toBe("2");
        await res.text().catch(() => "");
      }
    }
  });
});
describe("relay templates preserve upstream headers", () => {
  it("keeps multiple Set-Cookie values while adding the version header", async () => {
    const cookieServer = createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/plain",
        "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
      });
      res.end("ok");
    });
    await new Promise((r) => cookieServer.listen(0, "127.0.0.1", r));
    try {
      const origin = `http://127.0.0.1:${cookieServer.address().port}`;
      for (const [name, handler] of await loadHandlers()) {
        const res = await handler(
          relayRequest({ "x-relay-target": origin, "x-relay-path": "/poll" }),
        );
        expect(res.status, name).toBe(200);
        expect(res.headers.getSetCookie(), name).toHaveLength(2);
        expect(res.headers.get(RELAY_TEMPLATE_VERSION_HEADER), name).toBe("2");
      }
    } finally {
      await new Promise((r) => cookieServer.close(r));
    }
  });

  it("vercel converts an upstream fetch failure to a versioned 502", async () => {
    const [, vercel] = (await loadHandlers()).find(([name]) => name === "vercel");
    const res = await vercel(
      relayRequest({ "x-relay-target": "http://127.0.0.1:9", "x-relay-path": "/poll" }),
    );
    expect(res.status).toBe(502);
    expect(res.headers.get(RELAY_TEMPLATE_VERSION_HEADER)).toBe("2");
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
describe("relay templates honor x-relay-redirect (YAN-1598)", () => {
  it("returns the 302 unfollowed when the mode is error or manual", async () => {
    for (const [name, handler] of await loadHandlers()) {
      for (const mode of ["error", "manual"]) {
        targetHits = 0;
        const res = await handler(
          relayRequest({
            "x-relay-target": upstreamOrigin,
            "x-relay-path": "/poll",
            "x-relay-redirect": mode,
            "x-key": "k",
          }),
        );
        expect(res.status, `${name}/${mode}`).toBe(302);
        expect(res.headers.get("location"), `${name}/${mode}`).toBe(`${targetOrigin}/final`);
        expect(targetHits, `${name}/${mode}`).toBe(0);
        await res.text().catch(() => "");
      }
    }
  });

  it("follows the redirect when the header is missing", async () => {
    for (const [name, handler] of await loadHandlers()) {
      targetHits = 0;
      const res = await handler(
        relayRequest({
          "x-relay-target": upstreamOrigin,
          "x-relay-path": "/poll",
          "x-key": "k",
        }),
      );
      expect(res.status, name).toBe(200);
      expect(await res.text()).toBe("final");
      expect(targetHits, name).toBe(1);
    }
  });

  it("strips relay headers before forwarding upstream", async () => {
    let seen;
    const probe = createServer((req, res) => {
      seen = req.headers;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await new Promise((r) => probe.listen(0, "127.0.0.1", r));
    try {
      const origin = `http://127.0.0.1:${probe.address().port}`;
      for (const [name, handler] of await loadHandlers()) {
        seen = undefined;
        const res = await handler(
          relayRequest({
            "x-relay-target": origin,
            "x-relay-path": "/poll",
            "x-relay-redirect": "error",
            "x-key": "k",
          }),
        );
        expect(res.status, name).toBe(200);
        await res.text();
        expect(seen["x-relay-target"], name).toBeUndefined();
        expect(seen["x-relay-path"], name).toBeUndefined();
        expect(seen["x-relay-redirect"], name).toBeUndefined();
        expect(seen["x-key"], name).toBe("k");
      }
    } finally {
      await new Promise((r) => probe.close(r));
    }
  });
});
