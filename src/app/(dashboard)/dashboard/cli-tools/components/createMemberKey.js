import { withWorkspace } from "@/app/(dashboard)/dashboard/providers/connectTarget";

/**
 * Create a personal key for the signed-in user (YAN-374). The raw key is
 * returned once by the server; callers keep it in memory only — it is never
 * written to presets or tool settings.
 * POST /api/keys answers { key, name, id, metadata, storage } — only a
 * non-empty string `key` is accepted.
 * @param {string|null|undefined} workspaceId Active workspace (null: unscoped URL).
 * @returns {Promise<string>} the raw key
 */
export async function createMemberKey(workspaceId) {
  const day = new Date().toISOString().slice(0, 10);
  const res = await fetch(withWorkspace("/api/keys", workspaceId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "user", name: `CLI tools ${day}` }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || "Couldn't create a key.");
  if (typeof data?.key !== "string" || !data.key) {
    throw new Error("The server did not return a key.");
  }
  return data.key;
}
