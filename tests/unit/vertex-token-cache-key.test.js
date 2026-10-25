// YAN-1573: the Vertex service-account token cache is scoped to the full
// credential; distinct credentials get distinct cache entries.
import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { proxyAwareFetch } = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ default: vi.fn(), proxyAwareFetch }));

import { refreshVertexToken } from "../../open-sse/services/tokenRefresh.js";

const newKey = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;

const saJson = (clientEmail, privateKey) => ({
  type: "service_account",
  client_email: clientEmail,
  private_key: privateKey,
  project_id: "proj-1",
});

describe("refreshVertexToken cache is scoped to the full credential", () => {
  let minted;

  beforeEach(() => {
    minted = 0;
    proxyAwareFetch.mockReset();
    proxyAwareFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ access_token: `tok-${++minted}`, expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
  });

  it("gives distinct credentials distinct cache entries", async () => {
    const email = `cache-scope-${Date.now()}@proj-1.iam.gserviceaccount.com`;

    const first = await refreshVertexToken(saJson(email, newKey()), null);
    const second = await refreshVertexToken(saJson(email, newKey()), null);

    expect(first?.accessToken).toBe("tok-1");
    expect(second?.accessToken).toBe("tok-2");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("reuses the cached token for the same credential", async () => {
    const credential = saJson(`cache-hit-${Date.now()}@proj-1.iam.gserviceaccount.com`, newKey());

    const first = await refreshVertexToken(credential, null);
    const second = await refreshVertexToken({ ...credential }, null);

    expect(first?.accessToken).toBe("tok-1");
    expect(second?.accessToken).toBe("tok-1");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });
});
