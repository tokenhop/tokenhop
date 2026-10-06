# UX Research: YAN-359 SSO identity linking and JIT provisioning

Scope: research and design only. No application edits. Parent dispatches
implementation after the plan. Sources: Linear YAN-359, `docs/users/README.md`
(§3–§5), `docs/users/spec.md`, `docs/users/adr/0003-identity-and-bootstrap.md`,
and the current login and settings UI in this worktree (`dcae2aa3`).

## Executive Summary

Today an SSO login that does not link to a user lands on `/login?error=sso_not_linked`
and nothing else. YAN-359 adds three new user-visible outcomes: a new person is
provisioned as `pending` and must wait; a person outside the allowed groups is
rejected; an admin must be able to configure group mapping.

Recommendation, in short:

1. **Waiting page:** a new route `/login/pending`, rendered on the existing login
   shell (same `Card`, `BrandLockup`, `Callout`). It is not a dashboard page.
   A pending user has no valid session (`validateSessionToken` returns null for
   `instanceRole === "pending"`), so the page must be reachable without a session.
2. **Errors:** extend `loginErrors.js` with a small set of new codes. Keep
   the existing rule: unknown code → generic text, never reflect raw input.
3. **Admin config:** add a "Group mapping" block under the existing `SsoSection`,
   in a new `GroupMappingForm.js` next to `OidcForm.js` and `SamlForm.js`. It follows the
   existing `Input` / `SettingRow` / `Callout` / save-then-status pattern.
4. **Gating:** everything new is hidden unless `TOKENHOP_MULTI_USER` is on
   (`isMultiUserEnabled()` on the server; the `multiUser` shell flag on the client).
   With the switch off the login page, error text, and SSO settings stay as they
   are today.

Constraint I could not resolve from the repo alone: the client has no direct
read of "switch on" that works before login (see Open Questions 1). The pending
page and the login page need it from `/api/auth/status`.

## User Workflows

### Primary flow A: first SSO login, default role `pending`

1. User opens `/login`, clicks the SSO button (existing).
2. IdP authenticates, callback runs (existing OIDC callback / SAML ACS).
3. Server evaluates allow-list. User is in an allowed group, no linked identity.
   Server creates user + identity with role `pending`, writes audit
   `auth.login` with `result: "pending"`.
4. Server sets **no** dashboard session cookie (a pending user has no session today).
   It redirects to `/login/pending`.
5. Page shows the waiting state. User can close it, or come back later and sign in
   again. On the next SSO login the role is re-evaluated; if an admin approved
   them, they go straight to `/dashboard`.

Why a route and not `?error=`: waiting is not a failure. Putting it in the red
`Callout` on `/login` would tell people they did something wrong, and they did
not. It also lets us show who they signed in as and one useful next step.

How the page knows who they are with no session: the server sets a short-lived,
HttpOnly, signed cookie (`sso_pending`, about 15 min) that carries only a display
name/email and the provider label. It is never an auth token. Without the cookie
the page shows the generic text (no name). Reuse the pattern of
`passwordChangeSession` (`PASSWORD_CHANGE_COOKIE`) — it is the repo's existing
"no full session, short-lived challenge" precedent.

### Primary flow B: first SSO login, default role `user`

Same as A up to step 3, but the user gets a session and goes to `/dashboard`.
Nothing new on screen. Mapped workspaces appear through the existing workspace UI
(owned by other issues).

### Primary flow C: pending user is approved

Admin approves (user lifecycle UI is YAN-360/YAN-373, not this issue). From the
user's side: they return, press the SSO button again, and land on `/dashboard`.
The pending page tells them exactly this ("Sign in again once an admin approves
you"). No polling and no email from this issue — keep it boring.

### Primary flow D: user outside allowed groups

1. Same IdP round trip.
2. Server finds no group in `allowedGroups`. **No user row is created.**
3. Redirect to `/login?error=sso_group_denied`.
4. Login page shows the existing red "Sign-in failed" `Callout` with the new text.

### Primary flow E: admin configures mapping

1. Admin opens Settings → Single sign-on (existing `#sso` anchor).
2. Below the OIDC/SAML form, a new "Group access" block appears (multi-user on only).
3. Admin sets default role, groups claim name, allowed groups, admin groups, and
   group → workspace rows. Saves. Sees an inline success or error status.
4. Admin can press "Check a sign-in" later (nice to have, see Recommendations).

### Alternative / edge flows

| Situation                                                    | Behaviour                                                                                                                                      |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending user clicks the SSO button again, still not approved | Back to `/login/pending`. No error styling.                                                                                                    |
| Pending user opens `/dashboard` directly                     | Existing guard sends them to `/login`. Unchanged.                                                                                              |
| Visits `/login/pending` with no cookie                       | Show generic waiting text, no name, plus "Back to sign in". Do not 404, so a refresh or bookmark does not look broken.                         |
| Visits `/login/pending` with switch off                      | 404 (`requireMultiUser` pattern; page must call a status check and `notFound()`). With switch off, the page does not exist.                    |
| Disabled user via SSO                                        | Redirect to `/login?error=account_disabled` (text already exists).                                                                             |
| Provider returns `error=`                                    | Existing path. Today it reflects the raw `error` value as the code (callback route line 29); unknown values already map to generic text. Keep. |
| Admin removes the only admin group from mapping              | See validation table. Must not lock the admin out; owner is never governed by groups (ADR-0003).                                               |
| Groups missing from both id_token and UserInfo               | If `allowedGroups` is non-empty: reject with `sso_groups_missing` (different text from "denied", because the cause is admin-side).             |

## UI/UX Best Practices

Grounded in the components the repo already has. No new dependency.

### Waiting-for-approval page (`/login/pending`)

Layout — reuse the `/login` shell exactly (`main.min-h-screen`, `max-w-md`, centered
`BrandLockup`, then one `Card`):

- Visually hidden `h1` like `/login` has, plus a visible `EmptyState` heading (`as="h2"`)
  inside the `Card`. `EmptyState` already gives icon, centered title, body, action slot.
- Icon: `hourglass_top` (Material Symbols, same set as the rest of the app).
- Title: "Waiting for approval"
- Body: "You signed in as {name or email}. An admin needs to approve your account
  before you can use tokenhop." Second line: "Come back and sign in again once
  that is done."
- Action: `Button variant="secondary"` "Back to sign in" (links to `/login`).
- Optional extra `Callout variant="info"`: "Need access sooner? Ask an admin of this
  instance." Only if there is no better contact; there is no admin contact in the
  data model, so do not invent one.
- Status for assistive tech: the card region has `role="status"` (use `Callout`
  rather than a bare div, `Callout` already sets `role="status"`).

Wording rules (grounded, ordinary):

- Say "admin", not "administrator", not "approver", not "provisioned".
- Say "approve your account", not "activate your identity".
- No jargon: no "JIT", "IdP", "claims", "role" on this page. "Identity provider"
  appears only in admin settings, as it does today.
- Don't say "pending" as a label; say what is happening.

Accessibility:

- One `h1` (sr-only brand) + one visible `h2`. Same as `/login`.
- Page `<title>`: "Waiting for approval - tokenhop" (use `ACTIVE.name`).
- Focus: on load, no autofocus on the button; the heading is first in reading
  order. Do not trap focus.
- Colour is not the only signal: icon + words. The info/warn callout tint passes
  contrast already in both themes (existing tokens `bg-sky-bg`/`text-sky-ink`).
- Target size: `Button` is already 44 px high (`h-11` on `Select`/`Input`; same
  scale).
- Reduced motion: no animation; if the hourglass should move, wrap it with
  `motion-reduce:animate-none`. Recommend no animation at all.
- RTL: use logical classes (`ms-`/`me-`/`text-start`) as `EmptyState` does.

Responsive (handbook §7 step 6: 1440 / 1024 / 390, both themes, keyboard, RTL):

- The card is `w-full max-w-md` inside `p-4`; at 390 px it is 358 px wide, enough
  for the longest title with wrapping. `EmptyState`'s body is `max-w-[48ch]`, fine.
- No horizontal layout; nothing to break.

### Login errors

Add to `MESSAGES` in `src/app/login/loginErrors.js` (new keys only; do not
change existing text — tests may assert them):

| Code                   | Text (plain English)                                                                              | Whose fault                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `sso_group_denied`     | "Your account is not in a group that may sign in here. Ask an admin to add you."                  | User outside allowed groups                  |
| `sso_groups_missing`   | "Your sign-in provider did not send group information. Ask an admin to check the group settings." | Admin config / IdP                           |
| `sso_email_unverified` | "Your sign-in provider says this email is not verified, so it cannot be used to link an account." | Only relevant for admin opt-in email linking |
| `sso_link_conflict`    | "This sign-in is already linked to another account. Ask an admin for help."                       | Rare duplicate-identity case                 |

Already present and reused: `sso_not_linked`, `account_pending`, `account_disabled`,
`access_denied`, `too_many_attempts`.

Keep `sso_not_linked` for the case where the instance is **not** doing JIT (switch
off, or single-user). With multi-user on and JIT on, an unlinked identity no
longer produces that error; it produces provisioning.

Notes on security of the message text:

- Do not name the allowed groups on the login page. That leaks admin config to
  anyone who can authenticate at the IdP.
- Do not say whether the email exists as a user.
- Unknown `?error=` codes still map to "Sign-in failed. Try again." (existing).
- `describeLoginError` stays pure and client-safe.

Presentation: the existing `Callout variant="err" title="Sign-in failed"` in the
SSO block of `page.js` is correct. Keep it. It has `role="alert"`, so it is
announced on load.

### Admin-only SSO mapping configuration

Where: inside `SsoSection`, after the protocol form, before the existing
"SSO login is active" `Callout`s. Reason: that is the one place admins already
configure SSO, `#sso` deep links already work, and it keeps registry/search
consistent. Do not create a new settings section or a new top-level page —
YAN-373 owns the full users/workspaces/SSO admin UI; this issue should land the
smallest config surface that works.

Visibility: render only when both are true:

- multi-user switch on (client reads the `multiUser` flag already carried by
  `useShellStatus`; server enforces with `requireMultiUser()` regardless);
- the viewer is an admin or owner. Settings routes are admin-gated by the
  capability table (YAN-357), so the server remains the authority. On the client,
  hide the block if the settings PATCH for these keys returns 403 — never rely on
  hiding for security.

Form fields (all use existing `Input`, `Select`, `Textarea`, `Callout`, `Button`,
`SettingRow`; write to settings through the existing `saveSettings()`):

| Field                 | Control                                                                   | Default              | Help text                                                                                               |
| --------------------- | ------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------- |
| New accounts start as | `SegmentedControl` (two options): "Waiting for approval" / "Regular user" | Waiting for approval | "What a person gets the first time they sign in with SSO." Key: `defaultRole` (`pending` / `user`)      |
| Groups claim          | `Input`                                                                   | `groups`             | "Name of the field your provider sends groups in. Nested names like `realm_access.roles` work."         |
| Allowed groups        | `Textarea`, one per line                                                  | empty                | "Only people in one of these groups can sign in. Leave empty to allow everyone your provider signs in." |
| Admin groups          | `Textarea`, one per line                                                  | empty                | "People in these groups become admins."                                                                 |
| Group → workspace     | repeatable row list                                                       | empty                | "Add people in a group to a workspace with a role."                                                     |

Why `SegmentedControl` for the default role and not `Select`: the options are
exactly two, the existing "Sign-in method" and "Protocol" rows already use it, and
the safe default stays visible without opening a menu.

Group → workspace rows (`GroupWorkspaceRows`, a small sub-component inside
`GroupMappingForm.js`): each row is a CSS grid `grid-cols-1 sm:grid-cols-[1fr_1fr_8rem_auto]`
with `Input` (group name), `Select` (workspace), `Select` (role: Member / Manager /
Viewer — no Owner; owner is manual), and an `IconButton` "Remove row" with an
`aria-label` that names the row. An "Add mapping" `Button variant="ghost"` below.
At 390 px the row stacks; each control keeps its visible label.

Workspace options come from an existing workspaces list endpoint (YAN-353/356
repos). If no shared workspace exists, show an `EmptyState compact` inside the
block: "No shared workspaces yet. Create one first." with no action (the
workspace UI is out of scope here). Do not block saving the other fields.

Safety callouts (use `Callout`, as `SsoSection` does):

- `warn` when allowed groups are non-empty and "Admin groups" overlaps nothing in
  allowed: "People in admin groups can't sign in unless they are also in an allowed
  group." Computed client-side, informational.
- `info` always on: "The owner account is never changed by group settings."
  (ADR-0003: owner is never taken over; this reassures admins.)
- `info`: "Groups are checked on every sign-in. Access you added by hand is kept."
  (Matches the `source = 'idp'` rule, in ordinary words.)

Validation (client first, server is the source of truth):

| Condition                                                        | Message                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Groups claim empty                                               | "Enter the name of the groups field." Default silently to `groups` on blank, like `OidcForm` does for scopes. |
| Mapping row with group but no workspace                          | "Pick a workspace for “{group}”."                                                                             |
| Duplicate group in mapping                                       | "“{group}” is listed twice."                                                                                  |
| Allowed groups set, groups claim cannot be found in a test login | Handled at runtime as `sso_groups_missing`.                                                                   |

Save pattern — copy `OidcForm`: local `form` state, `busy` state `"" | "save"`,
`status` `{ type, message }` rendered in `<div aria-live="polite">` with
`Callout`. The block's own **Save group settings** button (not instant-save like
the segmented mode switches), because several fields belong together and a
half-edited allow-list that saves instantly could lock people out. This matches
how `OidcForm` and `SamlForm` already behave.

Lockout guard: if the saved `allowedGroups` would exclude the currently signed-in
admin's own groups, the server should refuse with a plain message (the settings
route already has a lockout guard for auth mode from YAN-349; reuse that style).
UI shows the server message in the status `Callout`. The owner is exempt by design.

### Settings registry and search

`src/app/(dashboard)/dashboard/settings/registry.js` drives search and the
command palette. Add rows to the existing `sso` section, tagged by key, so
"allowed groups", "admin groups", "default role", "groups claim", and "group
workspace" are findable. The registry has no gate field today. Two options:

- add a small optional `gate: "multiUser"` on a row and filter in `filterRows`
  and `toCommandItems` (small, mirrors `navigation.js`'s `gate` field), or
- leave the rows visible in search and have the block explain it is off.

Recommend the first; it matches `navigation.js` and keeps search results from
pointing at a block that is not rendered.

## Error Handling

### Login states

| State                | Where            | Component                      | Role   | Text source                 |
| -------------------- | ---------------- | ------------------------------ | ------ | --------------------------- |
| Not in allowed group | `/login`         | `Callout err` "Sign-in failed" | alert  | `sso_group_denied`          |
| Groups missing       | `/login`         | `Callout err`                  | alert  | `sso_groups_missing`        |
| Pending (SSO)        | `/login/pending` | `EmptyState` + `Callout info`  | status | page copy                   |
| Pending (password)   | `/login`         | existing field error           | alert  | `account_pending` (exists)  |
| Disabled             | `/login`         | `Callout err`                  | alert  | `account_disabled` (exists) |
| Not linked (no JIT)  | `/login`         | `Callout err`                  | alert  | `sso_not_linked` (exists)   |
| Provider/IdP failure | `/login`         | `Callout err`                  | alert  | existing `*_failed` codes   |
| Rate limited         | `/login`         | existing lock message          | status | existing                    |

Consistency note: today pending users on the **password** path see the text
"This account is waiting for an admin to approve it." as an error on the form.
Once SSO has a nicer page, a pending **password** user would ideally land on the
same page. That is YAN-358 territory (already shipped). Recommend leaving it
unchanged in this issue and listing it under Open Questions.

### Admin form states

| State                               | Display                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Saving                              | `Button loading`, all inputs `disabled` (as `OidcForm`)                                                          |
| Saved                               | `Callout ok` "Group settings saved."                                                                             |
| Server rejected (403, 400, lockout) | `Callout err` with `err.message` from `ssoApi`                                                                   |
| Workspace list fails to load        | Inline `Callout warn`: "Could not load workspaces. Mappings can't be edited right now." Other fields still work. |
| Switch turns off while page is open | Next save returns 404; hide the block and show `Callout info` "Multi-user is off." Do not crash.                 |

### What the page must not show

- No group names, workspace names, or other users' names on the login or pending pages.
- No raw error from the provider. The `error` query value is used only as a lookup key.
- No stack or server error text (existing rule: generic fallback).

## Performance UX

- Pending page is static content plus an optional read of the signed cookie on the
  server; render it as a server component with `cookies()`; no client fetch, no
  spinner. First paint is final content.
- `/login` already shows a `SkeletonText` while `/api/auth/status` resolves; keep it.
  Do not add a second round trip for the new flows.
- Admin block: load workspaces lazily when the block mounts; show
  `Skeleton` (existing) for the mapping area while loading. Do not block the
  rest of the SSO form on it.
- No polling for approval. A "Check again" button is unnecessary: the user signs in
  again, which re-evaluates the role. Avoids a new unauthenticated endpoint.
- Offline: the existing `catch` in `page.js` falls back to a generic error. The
  pending page needs no network once rendered.

## Gating and switch-off behaviour

Everything below must be invisible with `TOKENHOP_MULTI_USER` unset or `off`:

| Surface                          | Switch off                                                       | Switch on                                        |
| -------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| SSO callback result              | unchanged (`sso_not_linked` when unlinked)                       | JIT; may redirect to `/login/pending`            |
| `/login/pending`                 | 404                                                              | renders                                          |
| New `loginErrors` codes          | map exists but never emitted                                     | emitted                                          |
| "Group access" block in Settings | not rendered                                                     | rendered for admins                              |
| Registry rows for group settings | filtered out (gate)                                              | shown                                            |
| `/api/settings` group keys       | rejected or ignored; keys not in GET                             | read/write for admins                            |
| `/api/auth/status`               | pristine payload (byte-identical, as the route already promises) | adds `ssoJit` fields only in the enforced branch |

Key points:

- Server is the gate. Use `requireMultiUser()` for any new route, and
  `isMultiUserEnabled()` inside the SSO callbacks before taking the JIT path.
- Client hiding is cosmetic. The settings page already receives `multiUser`
  through shell status (`useShellStatus`, `visibleGroups`); reuse it. Do not add a
  second reader of the env var (`featureSwitch.js` is the only allowed reader).
- Preserve "switch-off UI": the SSO form, `describeLoginError`, `ssoOnly` /
  `both` callouts, and the login page text must render exactly as today. The
  safest check is a snapshot-style test with the switch off, and a Playwright pass
  at 390 / 1024 / 1440 in both themes.
- Do not change existing strings with the switch off. New keys only.

## Competitive Analysis

| Product                       | Pending/approval                                                                                                                                                | Group mapping UI              | Take / avoid                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Open WebUI                    | Dedicated "Account Activation Pending" screen with a short message and a sign-out link; default role `pending`; OIDC role and group claim fields in env, not UI | Env only                      | Take: separate calm page, `pending` default, short wording. Avoid: env-only config, and its group sync deleting manual memberships. |
| LiteLLM (admin UI SSO)        | New SSO users get a default role; admin UI has SSO settings with team/role mapping fields                                                                       | Form in admin UI              | Take: form in the admin UI, default role selector. Avoid: nested ownership layers.                                                  |
| Grafana                       | Auto-assign and org mapping via config; role attribute path                                                                                                     | Config file                   | Take: "role mapping rules" as plain rows. Avoid: expression strings admins have to learn.                                           |
| GitLab                        | "Your account is pending approval from your administrator" after sign up                                                                                        | Group sync in settings (paid) | Take: plain sentence naming the admin as the next step.                                                                             |
| Cloudflare Access / authentik | Policy denies show a clear "access denied" page naming the cause                                                                                                | Policy builder                | Take: a distinct message for "denied" vs "something broke".                                                                         |

Sources: Open WebUI SSO docs (`docs.openwebui.com/features/authentication-access/auth/sso/`),
RBAC roles (`.../rbac/roles/`), LiteLLM admin UI SSO (`docs.litellm.ai/docs/proxy/admin_ui_sso`),
authentik property mappings (`docs.goauthentik.io/add-secure-apps/providers/property-mappings/`) —
all already cited in handbook §2. Comparative claims about GitLab and Grafana are from
general product knowledge and should be confirmed before quoting in public docs.

Standards referenced: WCAG 2.2 SC 1.3.1 (info and relationships), 1.4.1 (use of
colour), 2.4.2 (page titled), 2.5.8 (target size), 4.1.3 (status messages).
The repo already meets these through `Callout` roles and `Button` sizing.

## File Map (bounded)

Only files this design needs. Parent can cut further.

Create:

- `src/app/login/pending/page.js` — server component, waiting page.
- `src/app/(dashboard)/dashboard/settings/sections/sso/GroupMappingForm.js` — admin
  block (fields, mapping rows, save, status). Keep under ~300 lines; if rows grow,
  split `GroupWorkspaceRows.js` beside it.

Modify:

- `src/app/login/loginErrors.js` — 4 new keys.
- `src/app/(dashboard)/dashboard/settings/sections/SsoSection.js` — render
  `GroupMappingForm` when `multiUser`; no change to existing behaviour.
- `src/app/(dashboard)/dashboard/settings/registry.js` — add gated rows to `sso`;
  optional `gate` support in `filterRows` / `toCommandItems`.
- `src/app/api/auth/oidc/callback/route.js` and
  `src/app/api/auth/saml/acs/route.js` — redirect to `/login/pending` or the new
  error codes (server design belongs to the technical research).
- `src/app/api/auth/status/route.js` — only if the pending page needs the switch
  state client-side (see Open Question 1); otherwise untouched.

Do not touch: `page.js` login layout beyond reading the new error codes,
`OidcForm.js`, `SamlForm.js`, `SettingsAnchorNav.js`, navigation constants.

Reuse as-is: `Callout`, `EmptyState`, `Card`, `Button`, `Input`, `Select`,
`Textarea`, `SegmentedControl`, `SettingRow`, `IconButton`, `Skeleton`,
`BrandLockup`.

## Recommendations

### Must have

1. `/login/pending` page on the login shell, no session, gated by the switch.
2. New `loginErrors` codes: `sso_group_denied`, `sso_groups_missing`
   (and `sso_link_conflict`, `sso_email_unverified` if the server can emit them).
3. "Group access" block in `SsoSection` with default role, groups claim, allowed
   groups, admin groups, and group → workspace rows; admin-only; explicit Save.
4. Switch-off parity: no new text, route, field or registry row is reachable off.
5. Server-side lockout protection and plain-English error from the settings route
   when a save would lock the admin out; owner exempt.
6. Accessible states: `role="alert"` for errors, `role="status"` for waiting, one
   `h1`, logical (RTL-safe) classes, 390 px stacked layout, keyboard-only pass.

### Should have

1. A "last sign-in groups" line in the admin block ("Last sign-in received:
   `staff, devs`") so admins can see what their IdP actually sends. Biggest
   single help for authentik's id_token-vs-UserInfo gotcha. Admin-only; never
   shown on login pages.
2. Warning callout when the groups claim returned nothing on the most recent
   admin sign-in.
3. Registry `gate` field so search matches what is rendered.

### Nice to have

1. "Check a sign-in" dry run that shows which role/workspaces a given email's
   groups would map to, without creating anyone. Needs a server endpoint; defer.
2. Count badge on the Settings anchor for "N people waiting" — belongs to YAN-373.
3. Remember-me style email prefill on the pending page. Skip; extra data on an
   unauthenticated page.

## Open Questions

1. **Reading the switch before login.** `/api/auth/status` exposes
   `multiUserActive` (users exist, security enforced), not "switch on". The
   pending page can gate on the server (`isMultiUserEnabled()` in a server
   component), so no client read is needed there. For the login page, nothing
   new is needed either (errors come from the server). The admin block uses the
   existing `multiUser` shell flag. Confirm that is acceptable; if not, add one
   boolean to the status payload in the enforced branch only.
2. **Pending password users.** Keep the inline `account_pending` error, or send
   them to `/login/pending` too? Recommend keep for this issue.
3. **Cookie for the display name.** Is a small signed `sso_pending` cookie
   acceptable, or should the page show only generic text? The generic-only
   fallback is safe and simpler; the cookie only improves a sentence.
4. **Role options for mapping rows.** Is `owner` ever mappable? Recommend no
   (owner is manual; manager/member/viewer only).
5. **`email_verified=false` copy.** Only needed if admin opt-in email linking
   ships in this issue. If not, drop `sso_email_unverified`.
6. **Who sees the block.** Admins and owner, per ADR-0002. Confirm that a
   workspace manager (non-admin) never sees SSO settings; today all of Settings
   is reachable by any authenticated session when the switch is off, which is
   fine since off means single admin.
7. **Localization.** Login error text is plain English in `loginErrors.js` while
   other surfaces use `src/i18n`. The existing file has no i18n; match it for now
   and flag for the i18n pass.
