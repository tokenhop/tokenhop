import { getConsistentMachineId } from "@/shared/utils/machineId";

// Machine-bound token the local tokenhop CLI sends in place of a login/API key.
// YAN-377: x-tokenhop-cli-token is the current name; x-9r-cli-token is the
// legacy name older CLI builds still send. Both are accepted; when a client
// sends both, the new header wins (the legacy value cannot mask a forged one).
export const CLI_TOKEN_HEADER = "x-tokenhop-cli-token";
export const CLI_TOKEN_HEADER_LEGACY = "x-9r-cli-token";
export const CLI_TOKEN_HEADERS = Object.freeze([CLI_TOKEN_HEADER, CLI_TOKEN_HEADER_LEGACY]);
const CLI_TOKEN_SALT = "9r-cli-auth";

let cachedCliToken = null;
export async function getCliToken() {
  if (!cachedCliToken) cachedCliToken = await getConsistentMachineId(CLI_TOKEN_SALT);
  return cachedCliToken;
}

export async function hasValidCliToken(request) {
  const token =
    request.headers.get(CLI_TOKEN_HEADER) ?? request.headers.get(CLI_TOKEN_HEADER_LEGACY);
  if (!token) return false;
  return token === (await getCliToken());
}
