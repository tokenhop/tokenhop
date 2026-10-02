// Codex CLI version tokenhop reports to OpenAI on `codex` provider traffic:
//   User-Agent `codex_cli_rs/<v>` + Version header on chat/image requests, and
//   `client_version=<v>` on the live model catalog (/backend-api/codex/models).
// The catalog drops models newer than the client, so a stale value returns 200
// with the newest models silently missing. Bump the default alongside Codex CLI
// releases, or set CODEX_CLI_VERSION; a malformed value throws at module load.

import { envString } from "./envOverride.js";

export const CODEX_CLI_VERSION = envString("CODEX_CLI_VERSION", "0.155.1", /^\d+\.\d+\.\d+$/);
