# User lifecycle and workspace invitations

Server-side APIs for inviting users, managing instance accounts and workspace membership. Requires `TOKENHOP_MULTI_USER=on`; every feature route is hidden with 404 while disabled. No invitation email delivery or UI exists. Operators relay invitation tokens out of band.

## Requirements

- Enable multi-user mode with `TOKENHOP_MULTI_USER=on` and require login before onboarding additional users. Password invitation acceptance refuses creation of a second account while login is disabled.
- Use authenticated browser sessions for management. Mutations require same-origin JSON where applicable. Responses use `Cache-Control: no-store`; invitation token responses also set `Referrer-Policy: no-referrer`.
- Workspaces must be shared workspaces. Personal workspaces cannot have invitations or managed members.

## Invitation API

Management requires a workspace owner/manager on that exact workspace. Active instance admins/owners with `instance.users.manage` can manage invitations and memberships in any shared workspace. Pending users cannot manage invitations. Instance-level authority does not expose personal workspace resources.

### Create invitation

`POST /api/workspaces/{workspaceId}/invitations`

```json
{ "role": "member", "email": "sam@example.invalid" }
```

`email` optional. Roles: `manager`, `member`, `viewer`. Granting `manager` requires workspace owner or instance admin. Server sets seven-day expiry; email is normalized.

Returns `201` with invitation metadata and raw `token`. Copy and deliver token securely out of band immediately: it is returned once and never shown by listing, revocation, audit, or logs. Token is single-use and expires after seven days.

### List and revoke

- `GET /api/workspaces/{workspaceId}/invitations` returns metadata and derived state (`live`, `expired`, `consumed`, `revoked`), never token/hash.
- `DELETE /api/workspaces/{workspaceId}/invitations/{inviteId}` revokes invite. Revoke is idempotent for terminal invitations; it cannot restore consumed invites.

### Accept invitation

`POST /api/invitations/accept` accepts a raw token in JSON body, never URL/query.

Password enrollment example:

```json
{
  "token": "<invitation-token>",
  "email": "sam@example.invalid",
  "username": "sam",
  "displayName": "Sam",
  "password": "<new-password>"
}
```

Creates approved `user`, personal workspace, password identity, and invited workspace membership atomically. Email-bound invitation requires matching normalized email. Response is a safe receipt; user must log in normally (no automatic login).

Existing authenticated user sends only `{ "token": "<invitation-token>" }`; session identity determines account, and endpoint adds membership only. Disabled/pending users and existing workspace members cannot accept. Email-bound invitation for existing account requires matching password-account email; SSO accounts use verified SSO acceptance instead.

OIDC/SAML: POST JSON `{ "invitationToken": "<invitation-token>" }` to `/api/auth/oidc/start` or `/api/auth/saml/start`. Success answers `200` JSON `{ "redirectUrl": "…" }`; the client navigates to `redirectUrl` itself (fetch cannot follow a cross-site 307). Start validates and rate-limits request, parks encrypted, flow-bound invite proof in an HttpOnly cookie, and never places the token in a redirect URL. Callback/ACS verifies identity and consumes invite. Email binding requires verified IdP email. Linking uses provider, issuer, and subject—not email. SSO allowed-group checks remain active. Existing membership conflicts rather than overwrites.

Invalid, expired, revoked, consumed, or mismatched invitations return generic `400 invite_invalid`; retry requires a new invitation. Requests are rate-limited.

## Other operator APIs

| Method and path                                         | Purpose                                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/users?page=1&pageSize=20`                     | Paginated safe user list; requires `instance.users.manage`; page size capped at 100.                                                                               |
| `PATCH /api/users/{userId}`                             | Approve with `instanceRole: "user"`, change role with `instanceRole: "admin"`, `"user"`, or `"pending"`, or change status with `status: "active"` or `"disabled"`. |
| `DELETE /api/users/{userId}`                            | Delete account and personal data; owner cannot be deleted.                                                                                                         |
| `POST /api/users/ownership-transfer`                    | Transfer ownership; see below.                                                                                                                                     |
| `GET /api/workspaces/{workspaceId}/members`             | List managed workspace members.                                                                                                                                    |
| `POST /api/workspaces/{workspaceId}/members`            | Add member with body `{ "userId": "<uuid>", "role": "member" }`; role may be `manager`, `member`, or `viewer`. Server sets source `manual`.                        |
| `PATCH /api/workspaces/{workspaceId}/members/{userId}`  | Change role; allowed values: `manager`, `member`, `viewer`.                                                                                                        |
| `DELETE /api/workspaces/{workspaceId}/members/{userId}` | Remove member.                                                                                                                                                     |

Members endpoints require exact workspace management capability; instance admins/owners may manage shared workspaces. `source='idp'` memberships are read-only to manual APIs. IdP membership conflicts return `409`; operations cannot overwrite existing memberships.

Instance role hierarchy: owner can manage admins and users; admins can manage `user`/`pending`; only owner grants/demotes admin. Owner is immutable through user PATCH/delete. Pending users cannot manage workspace invitations. Disable bumps session version and revokes user-owned keys; enable does not restore keys. Changes that leave a shared workspace without an active manager fail. Membership removal revokes that user's keys in that workspace only.

### Ownership transfer

`POST /api/users/ownership-transfer` requires `instance.ownership.transfer` and a live owner browser session. Request requires both fields:

```json
{ "toUserId": "<uuid>", "currentPassword": "<current-password>" }
```

Current password is re-verified in request with login-style rate limiting. Session alone is not proof. Transfer demotes old owner and promotes active approved target atomically; both sessions become invalid. SSO-only owners get `403 reauth_unsupported` here and use the SSO flow instead:

`POST /api/users/ownership-transfer/sso` with `{ "toUserId": "<uuid>", "provider": "oidc" | "saml" }` returns `{ authorizeUrl }`. The browser follows it to a forced fresh IdP login (OIDC `prompt=login` + `max_age=0`, SAML `ForceAuthn`). The callback completes the transfer only when the IdP proves a fresh sign-in (OIDC `auth_time`, SAML `AuthnInstant`, both within 5 minutes and after the start) as the owner's own linked identity, and the owner's session version is unchanged. It never creates a login session; both owners are sent to `/login`. The flow state lives in an encrypted, HttpOnly, 10-minute `owner_transfer_state` cookie. SAML needs HTTPS (the cookie must be `SameSite=None; Secure` to survive the IdP's cross-site POST); over plain HTTP the start answers `409 reauth_unavailable`. A stale or abandoned transfer cookie never blocks a normal SSO login.

## Data and safety invariants

- Invitation roles cannot grant instance `admin`/`owner`; only workspace roles are assigned.
- Tokens are 256-bit random values, stored as SHA-256 hashes, consumed transactionally once. Failed acceptance does not partially create an account or consume token.
- User/member responses use safe metadata, not password hashes, tokens, API keys, session versions, or secret material.
- Deleting user removes personal workspace data and user-owned keys; shared data survives, creator references become null, invitations survive issuer deletion, and service keys (`userId IS NULL`) survive. Personal workspace key/value prefix is explicitly cleaned. DEK destruction is out of scope (YAN-365).
- Last active manager/owner protections are enforced during mutations, including concurrent changes.
- Audit records contain identifiers and role/status metadata, never invitation secrets.

## References

- [Feature spec](../plans/yan-360-invitations/feature-spec.md)
