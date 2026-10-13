// Loopback mocks for the YAN-378 rehearsal: OpenAI-compatible upstream with a
// fixed 2ms latency, and an OIDC IdP (RS256 JWKS, PKCE-checked token endpoint).
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { OIDC_SECRET, PROVIDER_SECRET, sleep } from "./core.mjs";

/** @param {(handler: Function) => Promise<string>} listen */
export async function startUpstream(listen) {
  let hits = 0;
  const url = await listen(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    if (
      req.url !== "/v1/chat/completions" ||
      req.headers.authorization !== `Bearer ${PROVIDER_SECRET}`
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    hits++;
    await sleep(2); // Fixed small latency, identical for every gateway variant.
    const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
    const common = { id: "chatcmpl-yan378", created: 1700000000, model: body.model };
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        [
          {
            ...common,
            object: "chat.completion.chunk",
            choices: [
              { index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null },
            ],
          },
          {
            ...common,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage,
          },
        ]
          .map((c) => `data: ${JSON.stringify(c)}\n\n`)
          .concat("data: [DONE]\n\n")
          .join(""),
      );
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ...common,
          object: "chat.completion",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage,
        }),
      );
    }
  });
  return { url, hits: () => hits };
}

/** @param {(handler: Function) => Promise<string>} listen */
export async function startIdp(listen) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    alg: "RS256",
    kid: "yan378-rsa",
    use: "sig",
  };
  const codes = new Map();
  let identity = "owner";
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const encode = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const url = await listen(async (req, res) => {
    const parsed = new URL(req.url, url);
    if (parsed.pathname === "/.well-known/openid-configuration")
      return json(res, 200, {
        issuer: url,
        authorization_endpoint: `${url}/authorize`,
        token_endpoint: `${url}/token`,
        jwks_uri: `${url}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    if (parsed.pathname === "/jwks") return json(res, 200, { keys: [jwk] });
    if (parsed.pathname === "/authorize") {
      const code = randomBytes(16).toString("hex");
      codes.set(code, { params: parsed.searchParams, identity });
      const callback = new URL(parsed.searchParams.get("redirect_uri"));
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", parsed.searchParams.get("state"));
      res.writeHead(302, { location: callback.href });
      res.end();
      return;
    }
    if (parsed.pathname === "/token") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const p = new URLSearchParams(raw);
      const grant = codes.get(p.get("code"));
      codes.delete(p.get("code"));
      if (!grant || p.get("client_secret") !== OIDC_SECRET)
        return json(res, 400, { error: "invalid_grant" });
      const a = grant.params;
      const challenge = createHash("sha256")
        .update(p.get("code_verifier") || "")
        .digest("base64url");
      if (
        challenge !== a.get("code_challenge") ||
        p.get("redirect_uri") !== a.get("redirect_uri") ||
        p.get("client_id") !== a.get("client_id")
      )
        return json(res, 400, { error: "invalid_grant" });
      const now = Math.floor(Date.now() / 1000);
      const head = encode({ alg: "RS256", kid: jwk.kid });
      const payload = encode({
        iss: url,
        aud: a.get("client_id"),
        sub: grant.identity,
        email: `${grant.identity}@yan378.fixture`,
        email_verified: true,
        preferred_username: grant.identity,
        groups: [],
        nonce: a.get("nonce"),
        iat: now,
        exp: now + 300,
      });
      const input = `${head}.${payload}`;
      return json(res, 200, {
        token_type: "Bearer",
        access_token: "synthetic-access",
        id_token: `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`,
      });
    }
    return json(res, 404, { error: "not_found" });
  });
  return {
    url,
    setIdentity: (v) => {
      identity = v;
    },
  };
}
