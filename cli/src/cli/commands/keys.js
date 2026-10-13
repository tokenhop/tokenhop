/**
 * `keys list|create|revoke|backup-hint` on the running local server.
 * `keys rotate` stays in keysRotate.js. The CLI token is never printed; a
 * freshly created key is printed exactly once ("store it now").
 */
const path = require("node:path");
const { requireShared } = require("../utils/requireShared");
const baseApi = require("../api/client");
const run_ = require("./_runApi");

const { getDataDir } = require("../../../hooks/sqliteRuntime");
const { ACTIVE } = requireShared("brand");
const BIN = ACTIVE.npmPackage;

const HELP = `
Usage: ${BIN} keys <command> [options]

  list [--workspace <id>] [--json]
  create <name> [--workspace <id>] [--type user|service] [--user <userId>]
  revoke <id> [--workspace <id>]
  backup-hint                 Where the master key lives + backup advice (no network)

Options: -p, --port <port>  Server port (default 20128); -h, --help
Multi-user key storage also requires TOKENHOP_MULTI_USER=on.
`;

function describe(res, port) {
  if (res.statusCode === 404 && !res.code)
    return "multi-user is not enabled on this server (TOKENHOP_MULTI_USER=on)";
  if (/^Network error/.test(res.error || "")) return run_.describeError(res, port);
  const message = typeof res.error === "string" ? res.error : res.error?.message;
  return message || "Request failed";
}

// Hashed storage needs a workspace: --workspace, else the context's one.
// Legacy storage (no hashed context) keeps the pristine call shapes.
async function resolveScope(api, opts) {
  if (opts.workspace) return { workspaceId: opts.workspace };
  const ctx = await api.getApiKeysContext();
  if (!ctx.success) throw new Error(describe(ctx, opts.port));
  return ctx.data.storage === "hashed" ? { workspaceId: ctx.data.workspaceId } : {};
}

async function backupHint(deps = {}) {
  const env = deps.env ?? process.env;
  const location = env.TOKENHOP_MASTER_KEY
    ? "the TOKENHOP_MASTER_KEY environment variable (value never printed)"
    : path.join((deps.getDataDir ?? getDataDir)(), "keys", "master");
  console.log(`The instance master key lives in ${location}.`);
  console.log(
    "It unlocks every encrypted credential, so back it up separately from the database; losing it makes encrypted credentials unrecoverable.",
  );
  return 0;
}

async function run(argv, deps = {}) {
  const api = deps.api ?? baseApi;
  let opts;
  try {
    opts = run_.parseArgs(argv, ["workspace", "type", "user", "json"]);
    if (opts.help || !opts.args.length) {
      console.log(HELP);
      return opts.help ? 0 : 1;
    }
    const [cmd, name, extra] = opts.args;
    if (cmd === "backup-hint") return backupHint(deps);
    if (extra !== undefined) throw new Error(`Unexpected argument: ${extra}`);
    if (opts.type && !["user", "service"].includes(opts.type)) {
      throw new Error("--type must be user or service");
    }
    if (opts.user && opts.type === "service")
      throw new Error("--user cannot be used with --type service");
    run_.configure(opts.port, api);

    if (cmd === "list") {
      const { workspaceId } = await resolveScope(api, opts);
      const res = await api.getApiKeys(workspaceId);
      if (!res.success) throw new Error(describe(res, opts.port));
      const keys = res.data.keys || [];
      if (opts.json) console.log(JSON.stringify(res.data, null, 2));
      else if (!keys.length) console.log("No API keys.");
      else
        for (const k of keys)
          console.log(
            `${k.id}  ${k.name ?? "(unnamed)"}  ${k.prefix ?? ""}${k.revokedAt ? "  (revoked)" : ""}`,
          );
      return 0;
    }
    if (cmd === "create") {
      if (!name) throw new Error(`Usage: ${BIN} keys create <name>`);
      const { workspaceId } = await resolveScope(api, opts);
      if (opts.user && !workspaceId) {
        throw new Error("--user needs workspace key storage (TOKENHOP_MULTI_USER=on)");
      }
      const res = workspaceId
        ? await api.createApiKey(name, {
            workspaceId,
            type: opts.type ?? "user",
            ...(opts.user && { userId: opts.user }),
          })
        : await api.createApiKey(name);
      if (!res.success) throw new Error(describe(res, opts.port));
      const key = res.data.key;
      if (key) {
        console.log(key);
        console.log("Created. Store it now: this key will never be shown again.");
      } else console.log(`Created ${name}.`);
      return 0;
    }
    if (cmd === "revoke") {
      if (!name) throw new Error(`Usage: ${BIN} keys revoke <id>`);
      const { workspaceId } = await resolveScope(api, opts);
      const res = await api.deleteApiKey(name, workspaceId);
      if (!res.success) throw new Error(describe(res, opts.port));
      console.log(`Revoked ${name}.`);
      return 0;
    }
    throw new Error(`Unknown command: ${cmd}`);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    return 1;
  }
}

module.exports = { run, backupHint };
