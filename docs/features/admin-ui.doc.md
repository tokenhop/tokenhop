# Admin UI: users, workspaces and SSO

YAN-373 adds instance administration pages and APIs. All are behind the **Users & teams** switch (off by default); admin pages, navigation and feature APIs return 404 while it is off. Pages and mutations use authenticated browser sessions, not API-key authentication.

## Navigation and permissions

The Admin navigation group exposes user management with `instance.users.manage` and SSO provisioning settings with `instance.settings.manage`. Its pending-approval badge queries `GET /api/users?role=pending&status=active&pageSize=1` and displays `totalItems`.

Instance owners and admins manage users and shared workspaces. The role hierarchy still applies: only the owner can grant or demote admin and manage admins; admins can manage users and pending accounts. Owner account cannot be modified or deleted. Workspace administration does not expose personal workspaces.

## Users

`/dashboard/admin/users` provides server-side search, role and status filters, pagination, and user details including linked identities, workspace count and last login. The detail page supports:

- Approve a pending user; change instance role; disable or enable account.
- Set temporary password. It is displayed once; user must change it at next sign-in.
- Sign out everywhere with `POST /api/users/:id/logout-all`. This invalidates browser sessions only; API keys remain valid. Owner cannot be targeted.
- Delete user, memberships, API keys and personal workspace data. Shared workspace data remains.
- Transfer ownership to an active approved user. Password owners re-enter current password; SSO-only owners use fresh provider reauthentication. Transfer demotes prior owner to admin and invalidates both sessions.

Disable immediately invalidates sessions and revokes the user's API keys; enabling does not restore revoked keys. Existing safeguards prevent removing the last active workspace manager.

## Workspaces

`/dashboard/admin/workspaces` lists shared workspaces from `GET /api/workspaces`. Detail uses `GET /api/workspaces/:id` and shows counts, including `grantBudgetsElsewhere`; `apiKeys` is `null` when legacy API-key storage prevents reliable counts. Detail includes workspace members and invitations.

Workspace deletion uses `DELETE /api/workspaces/:id` with an exact, strict JSON body. Supply exactly three fields:

```json
{
  "confirmWorkspaceId": "<workspace-id>",
  "acknowledgeDekDestruction": true,
  "currentPassword": "<current-password>"
}
```

Fresh proof is mandatory for every admin: password accounts prove with `currentPassword` (re-verified at deletion); SSO-only admins prove with a one-time `ssoProof` — no weaker fallback. SSO proof flow: `POST /api/workspaces/:id/reauth` with `{ "provider": "oidc" }` or `{ "provider": "saml" }`; follow returned `authorizeUrl` through a forced fresh IdP login; then `GET /api/workspaces/:id/reauth` consumes the completed result once and returns `ssoProof` for the DELETE body (`404 not_found` when no re-auth completed). Proof is bound to actor, session version and workspace; it expires five minutes after the flow starts. The Default workspace cannot be deleted.

Deletion is atomic. Cleanup removes grant budgets held in other workspaces for this workspace, SSO group-map entries, workspace key/value data and related records; foreign-key cascades clean dependent data. Workspace DEK is destroyed and caches purged; audit records deletion. **Backup caveat:** old backups combined with the master key can still restore old secrets.

## Invitations

Workspace details let authorized admins create, list and revoke invitations and manage members. Invitation API routes are documented in [User lifecycle and workspace invitations](users-lifecycle.doc.md).

`/invite` is public. Invitation token is carried in URL fragment, scrubbed from browser history/location, and submitted without putting it in a server request URL. Accept with password enrollment or SSO. Successful acceptance includes `workspaceName`; an already-member attempt returns `409 already_member` and does not consume invitation token.

## SSO provisioning preview

The provisioning settings page edits six policy keys: `ssoGroupsClaim`, `samlAttributeGroups`, `ssoAllowedGroups`, `ssoAdminGroups`, `ssoGroupWorkspaceMap`, and `ssoDefaultRole`. Draft policy is limited to 8 KB.

“Test with my token” uses `POST /api/auth/sso/preview` with `{ "provider": "oidc" | "saml", "policy": { ... } }`; `policy` may be omitted to preview saved policy. It starts a forced fresh IdP login. Return to `/dashboard/admin/sso?ssoPreview=1`, then `GET /api/auth/sso/preview` consumes result once. This is evaluation only: it never provisions users, links identities, writes policy, or mints a session. The administrator must have identity linked to selected provider; otherwise response code is `sso_not_linked`. Failed flows return to `?ssoPreview=failed`; workspace reauthentication failures use `?ssoReauth=failed`.

OIDC preview reads groups from verified `id_token` claims first, then matching `userinfo` response if absent. For authentik, configure group claims in the `id_token` when possible; preview reports which source supplied groups. Missing/invalid group claims fail preview rather than implying an empty group set.

## Operational limits

Fresh-proof slots are in-memory, single-process, capped at 512, and live for five minutes. Multi-process deployments need shared proof storage for reliable flows. An administrator can have one pending SSO proof check at a time. Proof failures use the same account/IP login lockout buckets as sign-in attempts.
