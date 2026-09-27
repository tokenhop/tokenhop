import { getConnectionLabel as getProviderLimitsLabel } from "@/app/(dashboard)/dashboard/quota/lib/quotaUtils.js";

/**
 * Primary account label: name, else email, else display name.
 * Re-exported from quota/lib so account labels stay consistent.
 */
export const getConnectionLabel = getProviderLimitsLabel;

/**
 * Secondary account label: the email when it differs from the name, else the
 * display name when it differs from the name.
 *
 * @param {{name?: string, email?: string, displayName?: string}} connection
 * @returns {string|null}
 */
export function getConnectionSecondaryLabel(connection) {
  if (!connection) return null;
  if (
    connection.name?.trim() &&
    connection.email?.trim() &&
    connection.name.trim() !== connection.email.trim()
  ) {
    return connection.email.trim();
  }
  if (
    connection.name?.trim() &&
    connection.displayName?.trim() &&
    connection.name.trim() !== connection.displayName.trim()
  ) {
    return connection.displayName.trim();
  }
  return null;
}
