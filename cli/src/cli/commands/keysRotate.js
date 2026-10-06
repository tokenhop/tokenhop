/**
 * `keys rotate` — rotate the instance master key (KEK) or one workspace DEK on
 * the running local server (YAN-365, owner only).
 *
 *   keys rotate [--workspace <id>] [--port <port>] [--yes]
 *
 * Talks to the loopback server with the existing CLI token client; never opens
 * the database or the key files. The confirmation prompt defaults to No: a
 * decline (or anything but y/yes) sends no request, `--yes` sends exactly one.
 * Output is kids/counts and backup reminders only — no key material.
 */

const { requireShared } = require("../utils/requireShared");
const api = require("../api/client");
const input = require("../utils/input");

const { ACTIVE } = requireShared("brand");

const DEFAULT_PORT = 20128;
const DEFAULT_HOST = "127.0.0.1";

const HELP = `
Usage: ${ACTIVE.npmPackage} keys rotate [options]

Rotate the instance master key, or one workspace's data key, on the running
${ACTIVE.slug} instance (owner only; requires users & teams to be turned on).

Options:
  --workspace <id>    Rotate only this workspace's data key
  -p, --port <port>   Server port (default: ${DEFAULT_PORT})
  -y, --yes           Skip the confirmation prompt
  -h, --help          Show this help
`;

function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, yes: false, workspace: undefined, help: false };
  const take = (i, flag) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("-")) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace") {
      if (opts.workspace !== undefined) throw new Error("--workspace given more than once");
      opts.workspace = take(i, a);
      i++;
    } else if (a === "--port" || a === "-p") {
      const raw = take(i, a);
      i++;
      if (!/^\d{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
        throw new Error(`Invalid port: ${raw}`);
      }
      opts.port = Number(raw);
    } else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

function describeError(res) {
  const code =
    res.code ?? res.data?.code ?? (typeof res.error === "object" ? res.error?.code : undefined);
  const message = typeof res.error === "string" ? res.error : (res.error?.message ?? "");
  if (res.statusCode === 404) {
    // `not_found` is the workspace-rotate miss; a codeless 404 is the hidden route.
    if (code === "not_found") return "Workspace not found.";
    return "Not available: users & teams is not turned on for this instance (or the workspace was not found).";
  }
  if (res.statusCode === 401 || res.statusCode === 403) {
    return "Not allowed: only the instance owner can rotate keys.";
  }
  if (res.statusCode === 409) {
    if (code === "KEK_ENV_MANAGED" || /KEK_ENV_MANAGED|Env-managed/.test(message)) {
      return `Key rotation refused: ${message}`;
    }
    return "Key operations are locked right now; restart the server and retry.";
  }
  if (res.statusCode === 503)
    return `Key rotation is unavailable: ${message || "encryption state unavailable"}.`;
  return message || "Key rotation failed";
}

async function run(argv, deps = {}) {
  const io = deps.input ?? input;
  const client = deps.api ?? api;
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    console.log(HELP);
    return 1;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const target = opts.workspace
    ? `the data key of workspace ${opts.workspace}`
    : "the instance master key";
  if (!opts.yes) {
    console.log(`This rotates ${target}.`);
    if (!opts.workspace) {
      console.log(
        "The new master key replaces the old one on this server. Back it up first; backups taken before the rotation need the previous key, so keep it offline.",
      );
    }
    const answer = String(await io.prompt("Continue? [y/N] "))
      .trim()
      .toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      console.log("Cancelled. No request was sent.");
      return 1;
    }
  }

  client.configure({ host: DEFAULT_HOST, port: opts.port });
  const res = opts.workspace
    ? await client.rotateWorkspaceKey(opts.workspace)
    : await client.rotateInstanceKey();

  if (!res.success) {
    console.error(`❌ ${describeError(res)}`);
    return 1;
  }
  const data = res.data || {};
  if (opts.workspace) {
    if (data.status === "noop") {
      console.log(`Workspace ${data.workspaceId}: nothing encrypted to rotate (key unchanged).`);
    } else {
      console.log(`Workspace ${data.workspaceId}: data key rotated.`);
      console.log(`  Old key id: ${data.oldDekKid}`);
      console.log(`  New key id: ${data.dekKid}`);
      console.log(`  Rows re-encrypted: ${data.rotated}`);
    }
    return 0;
  }
  console.log("Instance master key rotated.");
  console.log(`  Old key id: ${data.oldKid}`);
  console.log(`  New key id: ${data.newKid}`);
  console.log(`  Data keys re-wrapped: ${data.dekCount}`);
  console.log(
    "\nBack up the new master key now. Backups taken before this rotation can only be restored with the previous key; keep that key offline if you need them.",
  );
  return 0;
}

module.exports = { run, parseArgs };
