const api = require("../api/client");
const helper = require("./_runApi");

const HELP = `
Usage: tokenhop auth reset-mode password [--port <port>]

Restore password login on the running local server (instance owner only).
If the owner has no local password, prompts for a new password twice, hidden.
CLI token is never printed. Options: -p, --port <port>; -h, --help.
`;

async function run(argv, deps = {}) {
  const client = deps.api ?? api;
  const io = deps.io ?? { promptPassword: helper.promptPassword };
  try {
    const opts = helper.parseArgs(argv);
    if (opts.help) {
      console.log(HELP);
      return 0;
    }
    if (opts.args.length !== 1 || opts.args[0] !== "password") {
      throw new Error("Usage: tokenhop auth reset-mode password [--port <port>]");
    }
    helper.configure(opts.port, client);
    let res = await client.resetAuthMode({ mode: "password" });
    if (!res.success && res.statusCode === 409 && res.code === "OWNER_PASSWORD_REQUIRED") {
      console.log("The owner has no local password. Set one now to restore password login.");
      res = await client.resetAuthMode({
        mode: "password",
        password: await helper.newPassword(io),
      });
    }
    if (!res.success) throw new Error(helper.describeError(res, opts.port));
    console.log("Password login restored.");
    return 0;
  } catch (err) {
    console.error(`❌ ${err.message}`);
    return 1;
  }
}

module.exports = { run };
