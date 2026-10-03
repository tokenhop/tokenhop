/**
 * `auth setup-token` — mint a one-time owner setup token from the running local server.
 *
 * POST /api/auth/setup-token (CLI token header, local-only). The token is printed
 * to stdout once and never persisted or logged anywhere else.
 */

const { requireShared } = require("../utils/requireShared");
const api = require("../api/client");

const { ACTIVE } = requireShared("brand");

const DEFAULT_PORT = 20128;
const DEFAULT_HOST = "127.0.0.1";

const HELP = `
Usage: ${ACTIVE.npmPackage} auth setup-token [options]

Mint a one-time owner setup token for SSO owner linking on the running
${ACTIVE.slug} instance (requires users & teams to be turned on).

Options:
  -p, --port <port>   Server port (default: ${DEFAULT_PORT})
  -h, --help          Show this help
`;

function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") opts.port = parseInt(argv[++i], 10) || DEFAULT_PORT;
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

async function run(argv) {
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

  api.configure({ host: DEFAULT_HOST, port: opts.port });
  const res = await api.mintSetupToken();

  if (!res.success) {
    if (res.statusCode === 404) {
      console.error(`❌ Users & teams is not turned on for this instance.`);
    } else {
      const err = typeof res.error === "string" ? res.error : JSON.stringify(res.error);
      console.error(`❌ ${err}`);
    }
    return 1;
  }

  const { token, expiresAt } = res.data || {};
  if (!token || !expiresAt) {
    console.error("❌ Unexpected response from server (missing token/expiresAt)");
    return 1;
  }

  console.log(`Setup token: ${token}`);
  console.log(`Expires at:  ${expiresAt}`);
  console.log(
    `\nOpen /api/auth/oidc/start?setupToken=${token} (or /api/auth/saml/start?setupToken=${token}) on this instance and sign in with the owner's SSO account. Single use, expires at ${expiresAt}.`,
  );
  return 0;
}

module.exports = { run, parseArgs };
