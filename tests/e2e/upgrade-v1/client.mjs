// HTTP client, login helpers and v1.0.3 seeding for the YAN-378 rehearsal.
import assert from "node:assert/strict";
import { check, OIDC_SECRET, PASSWORD, PROVIDER_SECRET, SAML_CERT, secrets } from "./core.mjs";

export function scanResponse(text, headers) {
  assert(
    text.length <= 8 * 1024 * 1024,
    `response body ${text.length} bytes exceeds 8 MiB scan bound`,
  );
  const surface = `${text}\n${headers ? [...headers].map(([k, v]) => `${k}: ${v}`).join("\n") : ""}`;
  for (const secret of [...secrets, PASSWORD])
    assert(!surface.includes(secret), "SENSITIVE: seeded secret in response body/headers");
}

// SSE frames may span chunks. Stop at first complete data frame, with bounded
// time and memory; cancel/abort always, including failures.
export async function firstDataFrame(response, controller, timeoutMs = 5000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`usage SSE first data timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      text += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      assert(text.length <= 1024 * 1024, "usage SSE frame exceeds 1 MiB");
      scanResponse(text, response.headers);
      const frame = text.replaceAll("\r\n", "\n").match(/(?:^|\n\n)(data: [\s\S]*?)\n\n/);
      if (frame)
        return frame[1]
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
      assert(!done, "usage SSE closed before first data frame");
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    await reader.cancel().catch(() => {});
  }
}

export function client(base, initialCookie = "", scan = false) {
  const jar = new Map(
    initialCookie
      .split("; ")
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf("=");
        return [c.slice(0, i), c.slice(i + 1)];
      }),
  );
  const call = async (method, route, body, headers = {}) => {
    const response = await fetch(route.startsWith("http") ? route : `${base}${route}`, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
      headers: {
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        origin: base,
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of response.headers.getSetCookie()) {
      const value = c.split(";")[0];
      const i = value.indexOf("=");
      jar.set(value.slice(0, i), value.slice(i + 1));
    }
    const text = await response.text();
    if (scan) scanResponse(text, response.headers);
    if (text.length > 8 * 1024 * 1024)
      throw new Error(`response body ${text.length} bytes exceeds 8 MiB scan bound for ${route}`);
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: response.status, ok: response.ok, headers: response.headers, text, json };
  };
  return { call, cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
}
export const passwordLoginBody = (identifier) => ({
  password: PASSWORD,
  ...(identifier ? { login: identifier } : {}),
});
export function ownerLoginFrom(rows) {
  assert(rows?.length === 1, "exactly one active owner required for password re-login");
  const id = rows[0].username || rows[0].email;
  assert(id, "owner login identifier missing");
  return id;
}
export async function login(app, scan = false, identifier) {
  const c = client(app.base, "", scan);
  const res = await c.call("POST", "/api/auth/login", passwordLoginBody(identifier));
  check(
    `password login${identifier ? ` (${identifier})` : ""}`,
    res.status === 200 && c.cookie().includes("auth_token="),
    `HTTP ${res.status}`,
  );
  return c;
}
export async function oidcLogin(app) {
  const c = client(app.base, "", true);
  const start = await c.call("GET", "/api/auth/oidc/start");
  const auth = await c.call("GET", start.headers.get("location"));
  const callback = await c.call("GET", auth.headers.get("location"));
  check(
    "OIDC RS256 login",
    callback.headers.get("location") === `${app.base}/dashboard`,
    callback.headers.get("location"),
  );
  return c;
}
export async function chat(app, key, model = "yan378-combo-a", stream = false) {
  const r = await fetch(`${app.base}/v1/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      stream,
      messages: [{ role: "user", content: "synthetic fixture" }],
    }),
  });
  const text = await r.text();
  scanResponse(text, r.headers);
  return { status: r.status, ok: r.ok, text };
}
export async function seed(h, app, full = true) {
  let c = await login(app);
  // Persist password through release's real settings API; INITIAL_PASSWORD
  // alone does not create stored password hash for owner bootstrap.
  const pw = await c.call("PATCH", "/api/settings", {
    newPassword: PASSWORD,
    requireLogin: true,
    requireApiKey: true,
  });
  check("stored password seeded", pw.ok);
  c = await login(app);
  const node = await c.call("POST", "/api/provider-nodes", {
    name: "yan378-node",
    prefix: "fx",
    type: "openai-compatible",
    apiType: "chat",
    baseUrl: h.upstream,
  });
  check("compatible node seeded", node.status === 201);
  const conn = await c.call("POST", "/api/providers", {
    provider: node.json.node.id,
    name: "yan378-connection",
    apiKey: PROVIDER_SECRET,
    testStatus: "active",
  });
  check("connection seeded", conn.status === 201);
  const keys = [];
  const keyIds = [];
  for (let i = 1; i <= (full ? 2 : 1); i++) {
    const k = await c.call("POST", "/api/keys", { name: `yan378-key-${i}` });
    check(`key ${i} seeded`, k.status === 201 && typeof k.json.key === "string");
    keys.push(k.json.key);
    keyIds.push(k.json.id);
  }
  const combos = [];
  for (const name of ["yan378-combo-a", ...(full ? ["yan378-combo-b"] : [])]) {
    const r = await c.call("POST", "/api/combos", { name, models: ["fx/gpt-4o-mini"] });
    check(`${name} seeded`, r.status === 201);
    combos.push(r.json.id);
  }
  if (full) {
    check(
      "aliases seeded",
      (
        await c.call("PUT", "/api/models/alias", {
          alias: "yan378-alias",
          model: "fx/gpt-4o-mini",
        })
      ).ok,
    );
    const sso = await c.call("PATCH", "/api/settings", {
      authMode: "both",
      ssoType: "oidc",
      oidcIssuerUrl: h.idp,
      oidcClientId: "yan378-client",
      oidcClientSecret: OIDC_SECRET,
      samlEntryPoint: "https://idp.yan378.invalid/sso",
      samlIssuer: "urn:yan378:sp",
      samlCert: SAML_CERT,
    });
    check("OIDC/SAML config seeded", sso.ok);
    const settings = await c.call("GET", "/api/settings");
    check(
      "SAML persisted (issuer + cert)",
      settings.json.samlIssuer === "urn:yan378:sp" && settings.json.samlCert === SAML_CERT,
    );
    await oidcLogin(app);
  }
  return { keys, keyIds, combos, conn: conn.json.connection.id, node: node.json.node.id, c };
}
