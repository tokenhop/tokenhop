// YAN-1598: end-to-end check of the redirect mode through a real relay. The
// loopback "relay" runs the deployed VERCEL_RELAY_CODE handler; the upstream
// 302s to a recording target. No fetch stub: proxyAwareFetch uses the real
// global fetch, so undici's own redirect handling is exercised.
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERCEL_RELAY_CODE } from "@/lib/network/relayTemplates";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

let targetHits = 0;
let target;
let upstream;
let relay;
let upstreamUrl;
let relayUrl;

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

// Adapt a Node request to the fetch-style Request the edge handler expects.
function toRequest(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value != null) headers.set(name, value);
  }
  return new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers });
}

beforeAll(async () => {
  const relayModule = await import(`data:text/javascript,${encodeURIComponent(VERCEL_RELAY_CODE)}`);

  target = createServer((_req, res) => {
    targetHits += 1;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("final");
  });
  await listen(target);
  const targetOrigin = `http://127.0.0.1:${target.address().port}`;

  upstream = createServer((_req, res) => {
    res.writeHead(302, { location: `${targetOrigin}/final` });
    res.end();
  });
  await listen(upstream);
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}/poll`;

  relay = createServer(async (req, res) => {
    try {
      const response = await relayModule.default(toRequest(req));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await listen(relay);
  relayUrl = `http://127.0.0.1:${relay.address().port}/forward`;
});

afterAll(async () => {
  await Promise.all([close(relay), close(upstream), close(target)]);
});

describe("redirect mode through a relay, end to end (YAN-1598)", () => {
  it('redirect: "error" rejects as a refused redirect and never reaches the target', async () => {
    targetHits = 0;
    const err = await proxyAwareFetch(
      upstreamUrl,
      { redirect: "error", headers: { "x-key": "k" } },
      { vercelRelayUrl: relayUrl },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toContain("Redirect refused");
    expect(err.cause.cause.message).toBe("unexpected redirect");
    expect(targetHits).toBe(0);
  });

  it('redirect: "manual" resolves the 302 with its Location and never reaches the target', async () => {
    targetHits = 0;
    const res = await proxyAwareFetch(
      upstreamUrl,
      { redirect: "manual", headers: { "x-key": "k" } },
      { vercelRelayUrl: relayUrl },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/final$/);
    expect(targetHits).toBe(0);
  });

  it("control: without a redirect mode the redirect is followed", async () => {
    targetHits = 0;
    const res = await proxyAwareFetch(
      upstreamUrl,
      { headers: { "x-key": "k" } },
      { vercelRelayUrl: relayUrl },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("final");
    expect(targetHits).toBe(1);
  });
});
