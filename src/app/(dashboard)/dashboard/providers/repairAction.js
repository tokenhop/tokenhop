import { connectionHealth } from "@/shared/utils/providerHealth";

/** Route repair actions only to a flow capable of changing the stored credential. */
export function repairTarget(connection) {
  const health = connectionHealth(connection);
  if (health.action !== "reconnect") return "open";
  return connection.authType === "oauth" ? "reauthorize" : "edit";
}
