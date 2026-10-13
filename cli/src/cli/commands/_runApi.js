const api = require("../api/client");
const readline = require("node:readline");

function parseArgs(argv, allowed = []) {
  const opts = { port: 20128, args: [] };
  const flags = new Set(["port", ...allowed]);
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--json" && allowed.includes("json")) opts.json = true;
    else if (arg.startsWith("-")) {
      if (arg === "-p") arg = "--port";
      const flag = arg.slice(2);
      if (!flags.has(flag)) throw new Error(`Unknown option: ${arg}`);
      if (Object.hasOwn(opts, flag) && flag !== "port") throw new Error(`${arg} given twice`);
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error(`${arg} needs a value`);
      opts[flag] = value;
    } else opts.args.push(arg);
  }
  if (!/^\d{1,5}$/.test(String(opts.port)) || Number(opts.port) < 1 || Number(opts.port) > 65535) {
    throw new Error(`Invalid port: ${opts.port}`);
  }
  opts.port = Number(opts.port);
  return opts;
}

function describeError(res, port = 20128) {
  const message = typeof res.error === "string" ? res.error : res.error?.message;
  // A codeless 404 is the hidden-route answer; coded 404s (not_found) are real misses.
  if (res.statusCode === 404 && !res.code) {
    return "multi-user is not enabled on this server (TOKENHOP_MULTI_USER=on)";
  }
  if (res.statusCode === 401)
    return "Unauthorized: run the CLI on the server host as the same OS user that runs tokenhop.";
  if (res.statusCode === 403) {
    return message && message !== "Forbidden"
      ? `Forbidden: ${message}`
      : "Forbidden: only the instance owner may do this.";
  }
  if (/^Network error/.test(message || "")) {
    return `tokenhop server is not running on 127.0.0.1:${port} — start it with \`tokenhop\``;
  }
  return message || "Request failed";
}

// Raw keypress input: no echo (not even stars); refuse pipes rather than risk
// exposing a password through line-mode input. Restore the TUI's prior raw mode.
function promptPassword(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY)
    return Promise.reject(new Error("Password input requires an interactive terminal"));
  return new Promise((resolve, reject) => {
    const wasRaw = stdin.isRaw;
    const wasPaused = stdin.isPaused();
    let value = "";
    readline.emitKeypressEvents(stdin);
    const finish = (error) => {
      stdin.removeListener("keypress", onKey);
      stdin.removeListener("end", onEnd);
      stdin.setRawMode(Boolean(wasRaw));
      if (wasPaused) stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onEnd = () => finish(new Error("Password input ended"));
    const onKey = (text, key = {}) => {
      if (key.ctrl && key.name === "c") return finish(new Error("Cancelled"));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") value = Array.from(value).slice(0, -1).join("");
      else if (
        text &&
        !key.ctrl &&
        !key.meta &&
        text.codePointAt(0) >= 32 &&
        text.codePointAt(0) !== 127
      )
        value += text;
    };
    stdin.on("keypress", onKey);
    stdin.once("end", onEnd);
    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write(question);
  });
}

async function newPassword(io = { promptPassword }) {
  const password = await io.promptPassword("New password (hidden): ");
  if (!password || password.length > 1024)
    throw new Error("Password must be nonempty and at most 1024 characters");
  if (password !== (await io.promptPassword("Confirm password (hidden): ")))
    throw new Error("Passwords do not match");
  return password;
}

function configure(port, client = api) {
  client.configure({ host: "127.0.0.1", port });
}

module.exports = { parseArgs, describeError, promptPassword, newPassword, configure };
