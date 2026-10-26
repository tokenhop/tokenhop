// fetchImageAsBase64 validates the image host with one DNS lookup and must
// connect to that validated address on every path. Through a connection or env
// proxy, the proxy must be asked for the validated IP (Host header and TLS SNI
// unchanged), never the hostname, which the proxy would resolve again.
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({ lookup: (...a) => lookupMock(...a) }));

const { fetchImageAsBase64, isPrivateIp } = await import(
  "../../open-sse/translator/concerns/image.js"
);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const VALIDATED_IP = "93.184.216.34";
const HOST = "img.rebind.example";

// Loopback proxies record what they were asked to reach and serve the image
// themselves (plain HTTP) or terminate TLS locally, so nothing leaves the host.
const seen = [];
const origin = http.createServer((req, res) => {
  seen.push({ kind: "origin", host: req.headers.host });
  res.writeHead(200, { "content-type": "image/png" });
  res.end(PNG);
});
// TLS endpoint without a certificate: records the ClientHello SNI, then fails
// the handshake. The fetch returns null; the recorded SNI is what matters.
const tlsSink = tls.createServer({
  SNICallback: (servername, cb) => {
    seen.push({ kind: "sni", servername });
    cb(new Error("no certificate in test"));
  },
});
tlsSink.on("tlsClientError", () => {});

function handOff(socket, port) {
  if (port === "443") tlsSink.emit("connection", socket);
  else origin.emit("connection", socket);
}

const httpProxy = http.createServer((req, res) => {
  seen.push({ kind: "absolute", target: req.url });
  res.writeHead(200, { "content-type": "image/png" });
  res.end(PNG);
});
httpProxy.on("connect", (req, socket, head) => {
  seen.push({ kind: "connect", target: req.url });
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head?.length) socket.unshift(head);
  handOff(socket, req.url.slice(req.url.lastIndexOf(":") + 1));
});

// Minimal SOCKS5 (no auth, CONNECT): records ATYP and destination address.
const socksProxy = net.createServer((socket) => {
  socket.once("data", () => {
    socket.write(Buffer.from([5, 0]));
    socket.once("data", (req) => {
      const atyp = req[3];
      let address;
      let portOffset;
      if (atyp === 1) {
        address = [...req.subarray(4, 8)].join(".");
        portOffset = 8;
      } else if (atyp === 3) {
        address = req.subarray(5, 5 + req[4]).toString();
        portOffset = 5 + req[4];
      } else {
        address = req.subarray(4, 20).toString("hex");
        portOffset = 20;
      }
      const port = String(req.readUInt16BE(portOffset));
      seen.push({ kind: "socks", atyp, target: `${address}:${port}` });
      socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      handOff(socket, port);
    });
  });
});

const servers = [origin, tlsSink, httpProxy, socksProxy];
let httpProxyUrl;
let socksProxyUrl;

const PROXY_ENV_VARS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
];

const viaConnectionProxy = (url) => ({
  proxyOptions: { connectionProxyEnabled: true, connectionProxyUrl: url, strictProxy: true },
});

beforeAll(async () => {
  await new Promise((resolve) => httpProxy.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => socksProxy.listen(0, "127.0.0.1", resolve));
  httpProxyUrl = `http://127.0.0.1:${httpProxy.address().port}`;
  socksProxyUrl = `socks5://127.0.0.1:${socksProxy.address().port}`;
});
afterAll(async () => {
  for (const server of servers) server.closeAllConnections?.();
  await Promise.all(
    servers.filter((s) => s.listening).map((s) => new Promise((resolve) => s.close(resolve))),
  );
});
beforeEach(() => {
  seen.length = 0;
  for (const name of PROXY_ENV_VARS) vi.stubEnv(name, "");
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: VALIDATED_IP, family: 4 }]);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const proxyTargets = () =>
  seen.filter((e) => ["connect", "absolute", "socks"].includes(e.kind)).map((e) => e.target);

function expectOnlyPinnedTargets(expected) {
  const targets = proxyTargets();
  expect(targets.length).toBeGreaterThan(0);
  for (const target of targets) {
    expect(target).toContain(expected);
    expect(target).not.toContain(HOST);
  }
}

describe("fetchImageAsBase64 through a proxy", () => {
  it("asks an HTTP connection proxy for the validated IP, keeping the Host header", async () => {
    const result = await fetchImageAsBase64(
      `http://${HOST}:8080/a.png?x=1`,
      viaConnectionProxy(httpProxyUrl),
    );

    expect(result?.mimeType).toBe("image/png");
    expect(lookupMock).toHaveBeenCalledTimes(1);
    expectOnlyPinnedTargets(`${VALIDATED_IP}:8080`);
    expect(seen.find((e) => e.kind === "origin")?.host).toBe(`${HOST}:8080`);
  });

  it("tunnels HTTPS to the validated IP with the real hostname as SNI", async () => {
    const result = await fetchImageAsBase64(
      `https://${HOST}/a.png`,
      viaConnectionProxy(httpProxyUrl),
    );

    expect(result).toBeNull(); // the test TLS endpoint has no certificate
    expectOnlyPinnedTargets(`${VALIDATED_IP}:443`);
    expect(seen.filter((e) => e.kind === "sni").map((e) => e.servername)).toEqual([HOST]);
  });

  it("asks an env proxy (HTTP_PROXY) for the validated IP", async () => {
    vi.stubEnv("HTTP_PROXY", httpProxyUrl);

    const result = await fetchImageAsBase64(`http://${HOST}/a.png`);

    expect(result?.mimeType).toBe("image/png");
    expectOnlyPinnedTargets(`${VALIDATED_IP}:80`);
  });

  it("brackets a validated IPv6 address in the proxy target", async () => {
    lookupMock.mockResolvedValue([{ address: "2606:2800:220:1::1", family: 6 }]);

    const result = await fetchImageAsBase64(
      `http://${HOST}/a.png`,
      viaConnectionProxy(httpProxyUrl),
    );

    expect(result?.mimeType).toBe("image/png");
    expectOnlyPinnedTargets("[2606:2800:220:1::1]:80");
  });

  it("sends a SOCKS5 proxy the validated IP, not the hostname", async () => {
    const result = await fetchImageAsBase64(
      `http://${HOST}/a.png`,
      viaConnectionProxy(socksProxyUrl),
    );

    expect(result?.mimeType).toBe("image/png");
    expectOnlyPinnedTargets(`${VALIDATED_IP}:80`);
    expect(seen.find((e) => e.kind === "socks")?.atyp).toBe(1);
    expect(seen.find((e) => e.kind === "origin")?.host).toBe(HOST);
  });

  it("keeps the real hostname as SNI through a SOCKS5 tunnel", async () => {
    const result = await fetchImageAsBase64(
      `https://${HOST}/a.png`,
      viaConnectionProxy(socksProxyUrl),
    );

    expect(result).toBeNull();
    expectOnlyPinnedTargets(`${VALIDATED_IP}:443`);
    expect(seen.filter((e) => e.kind === "sni").map((e) => e.servername)).toEqual([HOST]);
  });

  it("never reaches the proxy when the host resolves to a private address", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    const result = await fetchImageAsBase64(
      `http://${HOST}/a.png`,
      viaConnectionProxy(httpProxyUrl),
    );

    expect(result).toBeNull();
    expect(seen).toHaveLength(0);
  });
});

describe("isPrivateIp IPv4-compatible range", () => {
  it("blocks the deprecated ::/96 range in both spellings", () => {
    expect(isPrivateIp("::7f00:1")).toBe(true);
    expect(isPrivateIp("::a00:5")).toBe(true);
    expect(isPrivateIp("::127.0.0.1")).toBe(true);
  });

  it("still allows public IPv4-mapped and global IPv6 addresses", () => {
    expect(isPrivateIp("::ffff:93.184.216.34")).toBe(false);
    expect(isPrivateIp("2606:2800:220:1::1")).toBe(false);
  });
});
