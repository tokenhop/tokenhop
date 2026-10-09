/** Append `workspaceId` query param to an OAuth API URL. Null/empty id returns url unchanged. */
export function withOAuthWorkspace(url, workspaceId = null) {
  if (!workspaceId) return url;
  const raw = String(url);
  const hashIdx = raw.indexOf("#");
  const base = hashIdx === -1 ? raw : raw.slice(0, hashIdx);
  const hash = hashIdx === -1 ? "" : raw.slice(hashIdx);
  const sep = base.includes("?") ? (/[?&]$/.test(base) ? "" : "&") : "?";
  return `${base}${sep}workspaceId=${encodeURIComponent(workspaceId)}${hash}`;
}
