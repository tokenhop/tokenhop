# Moving items between workspaces

YAN-701 adds a preview-and-confirm workflow for transferring managed resources between workspaces. Feature targets v1.1.0 (unreleased).

## Availability and permissions

Moves are available only while multi-user mode is enabled. With the switch off, the move feature is hidden and its API route returns not found.

The signed-in user must be an active member of both source and target workspaces, with the required management capability in each:

| Item                                            | Capability in both workspaces  |
| ----------------------------------------------- | ------------------------------ |
| Provider connections, provider nodes            | `workspace.connections.manage` |
| Combos, aliases, custom models, disabled models | `workspace.combos.manage`      |
| API keys                                        | `workspace.keys.manage`        |

API-key authentication and administrator bypass do not authorize moves. The server rechecks live membership and permissions during planning and again during the move.

## Supported items

Move one item or a selection of items:

- Provider connection
- Provider node
- Combo
- Model alias
- Custom model
- Disabled-model entry
- API key

The dashboard offers item-level move actions and bulk selection where available. In the dialog, choose a target workspace (the first eligible workspace is selected by default), review the preview, then confirm. Conflicts block the move. Warnings require explicit acknowledgement. A changed warning set is shown again and needs fresh acknowledgement.

## Preview and outcomes

Preview is read-only. It reports conflicts that prevent transfer and warnings that describe consequences. Examples include a target name/prefix clash, a provider node whose connections are not moving together, combo references left behind, active connection grants that will be revoked, provider-sharing terms, or a key budget that exceeds target workspace limits.

Fix conflicts by changing the selection or target and preview again. Read warnings before acknowledging: moving a connection revokes its active grants. Moving a connection into a shared workspace can also be subject to provider terms. Combo references to resources left in the source may no longer resolve in the target.

A provider node must move with all connections that use it. Connections referencing a node cannot move alone; a node cannot move while any of its connections remain behind.

## Transfer behavior

The move preserves resource IDs and applies as one atomic operation: if validation, credential handling, or audit recording fails, no selected item moves. Credentials on moved connections and nodes are re-encrypted for the target workspace; secrets are not returned by the API. API-key identity and hash remain unchanged.

Key-scoped budgets follow a moved API key, including limits and spend state. The target workspace's budget ceiling still applies. Usage history remains in its original workspace; moving an item does not relocate historical usage records.

Active grants on moved connections are revoked. Provider account ordering is recalculated in source and target. Combo strategy settings move with their combo.

## API

`POST /api/workspaces/{sourceWorkspaceId}/move` uses the browser session. Request JSON accepts only `targetWorkspaceId`, `items`, `preview`, and `confirm`:

```json
{
  "targetWorkspaceId": "workspace-b",
  "items": [{ "type": "connection", "id": "connection-id" }],
  "preview": true
}
```

`items` must contain 1–500 unique `{ "type", "id" }` entries. Valid types: `connection`, `node`, `combo`, `alias`, `customModel`, `disabledModel`, `apiKey`.

Set `preview: true` to receive `{ "preview": true, "moved": [], "conflicts": [], "warnings": [] }`. Omit or set `preview: false` to apply; use `confirm: true` to acknowledge warnings. Success returns `{ "preview": false, "moved": [...], "conflicts": [], "warnings": [...] }`; each moved entry includes `type` and unchanged `id`.

Common failures: `400` invalid request; `403` insufficient permissions; `404` unavailable workspace; `409` `move_conflict` when conflicts remain or `confirm_required` when warnings need acknowledgement; `500` unexpected failure. Conflict and warning entries identify affected type and ID and provide user-facing messages. Other failures return fixed error text, not internal details or secrets.

## Notes

- API-key moves require hashed API-key storage. Legacy raw-key storage cannot move API keys.
- Preview is not a reservation. State may change before apply; the server recomputes checks atomically and returns updated conflicts or warnings when needed.
