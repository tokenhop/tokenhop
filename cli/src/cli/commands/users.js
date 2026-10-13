/**
 * `users` and `workspaces` — owner-side lifecycle on the running local server.
 * Uses the host-local CLI token (acts as instance owner); the token is never printed.
 */
const { requireShared } = require("../utils/requireShared");
const baseApi = require("../api/client");
const baseUsers = require("../api/usersClient");
const run_ = require("./_runApi");

const { ACTIVE } = requireShared("brand");
const BIN = ACTIVE.npmPackage;
const ROLES = ["admin", "user", "pending"];
const MEMBER_ROLES = ["manager", "member", "viewer"];

const HELP = {
  users: `
Usage: ${BIN} users <command> [options]

  list [--search <text>] [--role <role>] [--status <status>] [--page <n>] [--json]
  approve <id>                  Pending user becomes a normal user
  role <id> <admin|user|pending>
  disable <id> | enable <id>
  reset-password <id>           Set a temporary password (prompted, hidden)
  transfer-owner <id>           Make <id> the owner (prompts for YOUR password)

Options: -p, --port <port>  Server port (default 20128); -h, --help
Requires TOKENHOP_MULTI_USER=on. The CLI token is host-local and acts as the owner.
`,
  workspaces: `
Usage: ${BIN} workspaces <command> [options]

  list [--json]
  members <workspaceId> [--json]
  add-member <workspaceId> <userId> [--role manager|member|viewer]
  remove-member <workspaceId> <userId>

Options: -p, --port <port>  Server port (default 20128); -h, --help
Requires TOKENHOP_MULTI_USER=on. The CLI token is host-local and acts as the owner.
`,
};

function table(rows, columns) {
  const cells = rows.map((row) => columns.map((c) => String(row[c] ?? "-")));
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)));
  const fmt = (r) =>
    r
      .map((v, i) => v.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  console.log(fmt(columns));
  for (const r of cells) console.log(fmt(r));
}

const need = (args, n, usage) => {
  if (args.length !== n) throw new Error(`Usage: ${BIN} ${usage}`);
};

async function usersCommand(opts, ctx) {
  const [cmd, id, extra] = opts.args;
  const u = ctx.users;
  const patch = (body, done) => async () => {
    const res = await u.updateUser(id, body);
    if (res.success) console.log(done);
    return res;
  };
  if (cmd === "list") {
    need(opts.args, 1, "users list");
    const filters = {};
    for (const k of ["search", "role", "status", "page"]) if (opts[k]) filters[k] = opts[k];
    const res = await u.listUsers(filters);
    if (!res.success) return res;
    if (opts.json) console.log(JSON.stringify(res.data, null, 2));
    else {
      table(res.data.users || [], ["id", "username", "email", "instanceRole", "status"]);
      const p = res.data.pagination;
      if (p) console.log(`page ${p.page}/${p.totalPages || 1}, ${p.totalItems} users`);
    }
    return res;
  }
  if (cmd === "approve") {
    need(opts.args, 2, "users approve <id>");
    return patch({ instanceRole: "user" }, `Approved ${id}.`)();
  }
  if (cmd === "disable") {
    need(opts.args, 2, "users disable <id>");
    return patch({ status: "disabled" }, `Disabled ${id}.`)();
  }
  if (cmd === "enable") {
    need(opts.args, 2, "users enable <id>");
    return patch({ status: "active" }, `Enabled ${id}.`)();
  }
  if (cmd === "role") {
    need(opts.args, 3, "users role <id> <admin|user|pending>");
    if (!ROLES.includes(extra)) throw new Error(`Role must be one of: ${ROLES.join(", ")}`);
    return patch({ instanceRole: extra }, `Role of ${id} set to ${extra}.`)();
  }
  if (cmd === "reset-password") {
    need(opts.args, 2, "users reset-password <id>");
    const password = await run_.newPassword(ctx.io);
    const res = await u.resetUserPassword(id, password);
    if (res.success)
      console.log(`Temporary password set for ${id}. They must change it at next login.`);
    return res;
  }
  if (cmd === "transfer-owner") {
    need(opts.args, 2, "users transfer-owner <id>");
    console.log(`This makes ${id} the instance owner and demotes you. Your password is required.`);
    const password = await ctx.io.promptPassword("Your current password (hidden): ");
    if (!password) throw new Error("Password is required");
    const res = await u.transferOwner(id, password);
    if (res.success) console.log(`Ownership transferred to ${id}.`);
    return res;
  }
  throw new Error(`Unknown command: ${cmd ?? "(none)"}`);
}

async function workspacesCommand(opts, ctx) {
  const [cmd, ws, userId] = opts.args;
  const u = ctx.users;
  if (cmd === "list") {
    need(opts.args, 1, "workspaces list");
    const res = await u.listWorkspaces();
    if (!res.success) return res;
    if (opts.json) console.log(JSON.stringify(res.data, null, 2));
    else table(res.data.workspaces || [], ["id", "name", "memberCount"]);
    return res;
  }
  if (cmd === "members") {
    need(opts.args, 2, "workspaces members <workspaceId>");
    const res = await u.listMembers(ws);
    if (!res.success) return res;
    if (opts.json) console.log(JSON.stringify(res.data, null, 2));
    else table(res.data.members || [], ["userId", "displayName", "role", "source"]);
    return res;
  }
  if (cmd === "add-member") {
    need(opts.args, 3, "workspaces add-member <workspaceId> <userId> [--role r]");
    const role = opts.role ?? "member";
    if (!MEMBER_ROLES.includes(role))
      throw new Error(`Role must be one of: ${MEMBER_ROLES.join(", ")}`);
    const res = await u.addMember(ws, userId, role);
    if (res.success) console.log(`Added ${userId} to ${ws} as ${role}.`);
    return res;
  }
  if (cmd === "remove-member") {
    need(opts.args, 3, "workspaces remove-member <workspaceId> <userId>");
    const res = await u.removeMember(ws, userId);
    if (res.success) console.log(`Removed ${userId} from ${ws}.`);
    return res;
  }
  throw new Error(`Unknown command: ${cmd ?? "(none)"}`);
}

async function run(group, argv, deps = {}) {
  const ctx = {
    users: deps.users ?? baseUsers,
    io: deps.io ?? { promptPassword: run_.promptPassword },
  };
  const client = deps.api ?? baseApi;
  let opts;
  try {
    opts = run_.parseArgs(
      argv,
      group === "users" ? ["search", "role", "status", "page", "json"] : ["role", "json"],
    );
    if (opts.help || !opts.args.length) {
      console.log(HELP[group]);
      return opts.help ? 0 : 1;
    }
    run_.configure(opts.port, client);
    const res = await (group === "users" ? usersCommand : workspacesCommand)(opts, ctx);
    if (res?.success === false)
      throw Object.assign(new Error(run_.describeError(res, opts.port)), { reported: true });
    return 0;
  } catch (err) {
    console.error(`❌ ${err.message}`);
    return 1;
  }
}

module.exports = {
  runUsers: (argv, deps) => run("users", argv, deps),
  runWorkspaces: (argv, deps) => run("workspaces", argv, deps),
};
