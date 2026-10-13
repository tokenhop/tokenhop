// Leg B second-user checks. Exact expected statuses are contract; a changed
// code/body is a review-visible failure, never silently widened.
import { chat, client, firstDataFrame, oidcLogin } from "./client.mjs";
import { check } from "./core.mjs";

async function expectCodes(prefix, checks, actual) {
  for (const { method, route, statuses } of checks) {
    const r = await actual(method, route);
    check(
      `${prefix} ${method} ${route}`,
      statuses.includes(r.status),
      `HTTP ${r.status} ${JSON.stringify(r.json?.error ?? "").slice(0, 100)}`,
    );
  }
}

export async function isolationChecks(h, app, fixture) {
  check(
    "second-user SSO provisioning enabled",
    (await fixture.c.call("PATCH", "/api/settings", { ssoDefaultRole: "user" })).ok,
  );
  h.setIdentity("user2");
  const second = await oidcLogin(app);
  check("second user role is user", (await second.call("GET", "/api/users")).status === 403);
  const context = await second.call("GET", "/api/keys/context");
  const ownWs = context.json.workspaceId;
  const k = await second.call("POST", `/api/keys?workspaceId=${ownWs}`, {
    name: "yan378-user2-key",
  });
  check("second-user personal key created", k.status === 201);
  const ownKey = k.json.key;
  // Positive control: user2 really can use the product inside own workspace,
  // so the negatives below are denial, not a broken account.
  const ownCombo = await second.call("POST", "/api/combos", {
    name: "yan378-combo-a",
    models: ["fx/gpt-4o-mini"],
  });
  check(
    "positive: user2 creates same-named combo in own workspace",
    ownCombo.status === 201 && ownCombo.json.id !== fixture.combos[0],
    `HTTP ${ownCombo.status}`,
  );
  const ownList = await second.call("GET", `/api/combos?workspaceId=${ownWs}`);
  check(
    "positive: user2 lists own combo only",
    ownList.json.combos.length === 1 && ownList.json.combos[0].id === ownCombo.json.id,
  );
  const r = await client(app.base, "", true).call("GET", "/v1/models", null, {
    authorization: `Bearer ${ownKey}`,
  });
  check("positive: user2 key authorizes /v1/models", r.status === 200, `HTTP ${r.status}`);
  const ownerCombos = await fixture.c.call("GET", `/api/combos?workspaceId=${fixture.defaultWs}`);
  check(
    "collision did not touch owner combos",
    ownerCombos.json.combos.length === 2 &&
      ownerCombos.json.combos.some((c) => c.id === fixture.combos[0]),
  );

  const secondCall = second.call;
  const bearer = (route) =>
    client(app.base, "", true).call("GET", route, null, { authorization: `Bearer ${ownKey}` });
  const cases = [
    { method: "GET", route: "/api/providers", statuses: [200] },
    { method: "GET", route: "/api/combos", statuses: [200] },
    { method: "GET", route: "/api/models/alias", statuses: [200] },
    { method: "GET", route: "/api/provider-nodes", statuses: [200] },
    { method: "GET", route: `/api/providers/${fixture.conn}`, statuses: [404] },
    { method: "GET", route: "/api/users", statuses: [403] },
    { method: "GET", route: "/api/audit", statuses: [200] },
    { method: "GET", route: "/api/settings", statuses: [403] },
    { method: "GET", route: "/api/settings/environment", statuses: [403] },
    { method: "GET", route: "/api/settings/config/export", statuses: [403] },
    { method: "GET", route: `/api/workspaces/${fixture.defaultWs}/settings`, statuses: [404] },
    { method: "GET", route: `/api/workspaces/${fixture.defaultWs}/members`, statuses: [404] },
    { method: "GET", route: "/api/usage/stats?period=all", statuses: [200] },
    { method: "GET", route: `/api/workspaces/${ownWs}/settings`, statuses: [200] },
  ];
  await expectCodes("session negatives", cases, secondCall);
  // Personal-workspace owner may read own (empty) audit; never owner rows.
  const auditOwn = await secondCall("GET", "/api/audit?pageSize=5");
  check(
    "second user audit has no owner rows",
    !auditOwn.text.includes("yan378-key") && !auditOwn.text.includes(fixture.conn),
  );
  // Lists may be empty; they must never name owner rows.
  for (const route of [
    "/api/providers",
    "/api/combos",
    "/api/models/alias",
    "/api/provider-nodes",
  ]) {
    const text = (await secondCall("GET", route)).text;
    check(
      `second user ${route} has no owner rows`,
      !text.includes(fixture.conn) &&
        !text.includes(fixture.combos[0]) &&
        !text.includes("yan378-combo-b") &&
        !text.includes("yan378-alias") &&
        !text.includes("yan378-node"),
      route,
    );
  }
  for (const route of ["/api/providers", "/api/combos", "/api/models/alias"]) {
    const r = await bearer(route);
    // Dashboard guard accepts sessions/CLI only; bearer alone is unauthorized.
    check(
      `second key ${route} denied`,
      r.status === 401 && r.json?.error === "Unauthorized",
      `HTTP ${r.status} ${r.text.slice(0, 60)}`,
    );
  }
  for (const model of ["yan378-combo-a", "yan378-alias", "fx/gpt-4o-mini"]) {
    const before = h.hits();
    const r = await chat(app, ownKey, model);
    check(
      `second key cannot use ${model}`,
      [400, 403, 404].includes(r.status) && h.hits() === before,
      `HTTP ${r.status}`,
    );
  }
  const foreign = await secondCall("GET", `/api/providers/${fixture.conn}`);
  check("second user cannot read owner connection", foreign.status === 404);
  const mut = await secondCall("PUT", `/api/providers/${fixture.conn}`, { name: "stolen" });
  check("second user cannot mutate owner connection", mut.status === 404, `HTTP ${mut.status}`);
  const del = await secondCall("DELETE", `/api/providers/${fixture.conn}`);
  check("second user cannot delete owner connection", del.status === 404, `HTTP ${del.status}`);
  const combo = await secondCall("PUT", `/api/combos/${fixture.combos[0]}`, { name: "stolen" });
  check("second user cannot mutate owner combo", combo.status === 404, `HTTP ${combo.status}`);
  // loadScoped: a foreign-workspace row reads as missing (NOT_FOUND), never
  // forbidden — otherwise the id would be enumerable.
  const comboDelete = await secondCall("DELETE", `/api/combos/${fixture.combos[0]}`);
  check(
    "second user cannot delete owner combo",
    comboDelete.status === 404,
    `HTTP ${comboDelete.status}`,
  );
  // Aliases are per-workspace kv rows: a write with only a workspace selector
  // the caller belongs to (their own) cannot touch the owner's key. Both
  // second-user calls below succeed writing into the SECOND user's workspace;
  // the owner's alias must be unchanged afterwards.
  const aliasPut = await secondCall("PUT", "/api/models/alias", {
    alias: "yan378-alias",
    model: "fx/stolen",
  });
  check(
    "second user cannot overwrite owner alias",
    aliasPut.status === 200,
    `HTTP ${aliasPut.status}`,
  );
  const afterPut = await fixture.c.call("GET", "/api/models/alias");
  check(
    "owner alias unchanged after foreign write",
    afterPut.json.aliases["yan378-alias"] === "fx/gpt-4o-mini",
  );
  const aliasDelete = await secondCall("DELETE", "/api/models/alias?alias=yan378-alias");
  check(
    "second user cannot delete owner alias",
    aliasDelete.status === 200,
    `HTTP ${aliasDelete.status}`,
  );
  const afterDelete = await fixture.c.call("GET", "/api/models/alias");
  check(
    "owner alias survives foreign delete",
    afterDelete.json.aliases["yan378-alias"] === "fx/gpt-4o-mini",
  );
  const nodeMut = await secondCall("PUT", `/api/provider-nodes/${fixture.node}`, {
    name: "stolen",
    prefix: "fx",
    apiType: "chat",
    baseUrl: h.upstream,
  });
  check("second user cannot mutate owner node", nodeMut.status === 404, `HTTP ${nodeMut.status}`);
  const nodeDelete = await secondCall("DELETE", `/api/provider-nodes/${fixture.node}`);
  check(
    "second user cannot delete owner node",
    nodeDelete.status === 404,
    `HTTP ${nodeDelete.status}`,
  );
  const exportWs = await secondCall("POST", `/api/workspaces/${fixture.defaultWs}/export`, {
    password: "synthetic-not-a-password",
    passphrase: "synthetic-backup-passphrase",
  });
  check(
    "second user cannot export owner workspace",
    exportWs.status === 404,
    `HTTP ${exportWs.status}`,
  );
  const keyDetail = await secondCall("GET", `/api/keys/${fixture.keyIds[0]}?workspaceId=${ownWs}`);
  check(
    "second user cannot read owner key detail",
    keyDetail.status === 404,
    `HTTP ${keyDetail.status}`,
  );
  // workspace.keys.manage on the OWNER's workspace: not a member -> NOT_FOUND.
  const revoke = await secondCall(
    "DELETE",
    `/api/keys/${fixture.keyIds[0]}?workspaceId=${fixture.defaultWs}`,
  );
  check("second user cannot revoke owner key", revoke.status === 404, `HTTP ${revoke.status}`);
  // Creating a connection needs a node visible in the SELECTED workspace; the
  // owner's node id is foreign, so the honest answer is node not found (404).
  const connCreate = await secondCall("POST", "/api/providers", {
    provider: fixture.node,
    name: "stolen",
    apiKey: "sk-synthetic-attacker",
    testStatus: "active",
  });
  check(
    "second user cannot attach owner node",
    connCreate.status === 404,
    `HTTP ${connCreate.status}`,
  );
  const exportReq = await secondCall("GET", "/api/settings/database");
  check("second user cannot export database", exportReq.status === 403, `HTTP ${exportReq.status}`);
  // Instance directories are admin-only: exact 403, no body leak.
  const wsList = await secondCall("GET", "/api/workspaces");
  check(
    "second user cannot list instance workspaces",
    wsList.status === 403 && !wsList.text.includes("Default"),
    `HTTP ${wsList.status}`,
  );
  const wsCreate = await secondCall("POST", "/api/workspaces", { name: "yan378-user2-ws" });
  check(
    "second user cannot create instance workspace",
    wsCreate.status === 403,
    `HTTP ${wsCreate.status}`,
  );
  const usageOwn = await secondCall("GET", "/api/usage/stats?period=all");
  check(
    "second user usage empty",
    usageOwn.json?.totalRequests === 0 || usageOwn.json?.totalRequests === undefined,
    JSON.stringify(usageOwn.json?.totalRequests),
  );
  const ac = new AbortController();
  const stream = await fetch(`${app.base}/api/usage/stream`, {
    headers: { cookie: second.cookie() },
    signal: ac.signal,
  });
  const frame = await firstDataFrame(stream, ac);
  const live = JSON.parse(frame || "{}");
  check(
    "second user usage stream sees none of owner traffic",
    stream.status === 200 &&
      !frame.includes("yan378-key") &&
      !JSON.stringify(live).includes("fx/gpt") &&
      !JSON.stringify(live).includes("gpt-4o-mini"),
    `HTTP ${stream.status} bytes=${frame.length}`,
  );
  const noKey = await chat(app, "", "yan378-combo-a");
  check("no-key chat denied", noKey.status === 401, `HTTP ${noKey.status}`);
  const badKey = await chat(app, "sk-bad", "yan378-combo-a");
  check("bad-key chat denied", badKey.status === 401, `HTTP ${badKey.status}`);
  // Name collision inside ONE workspace is rejected; across workspaces it was allowed above.
  const dup = await second.call("POST", "/api/combos", {
    name: "yan378-combo-a",
    models: ["fx/gpt-4o-mini"],
  });
  check(
    "same-workspace combo name collision rejected",
    dup.status === 400 && dup.json?.error === "Combo name already exists",
    `HTTP ${dup.status} ${dup.text.slice(0, 80)}`,
  );
}
