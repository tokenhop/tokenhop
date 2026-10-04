# UX Research: YAN-363 — hashed, workspace-scoped gateway API keys (GH #231)

Sources: GH #231, `docs/users/spec.md` (decision 5), `docs/users/adr/0005-api-keys.md` (binding format/hash/display decisions), `docs/users/adr/0002-roles-and-capabilities.md`, `docs/users/README.md` (handbook §4/§5/§8). Code verified in worktree `.claude/worktrees/tokenhop-users-api-keys` @ branch `users/yan-363-api-keys`.

## Executive Summary

Today's key UI is a single-admin, raw-key world: `GET /api/keys` returns the full key, the endpoint page masks it with an eye-toggle reveal and a per-row copy button, the CLI menu has "View Full Key" and "Copy Key" actions, and cli-tools/MITM read raw keys straight from the list response. YAN-363 makes keys hashed and owned: with the multi-user switch **on**, the raw key exists exactly once (the creation response) and every list/detail surface degrades to a prefix-only display with owner, scope and expiry metadata. With the switch **off**, every pixel, string and API shape stays exactly as today — that is a hard regression contract, not a nice-to-have. The minimum complete UX is: one-time reveal + copy at creation (already built, keep it), a prefix-only list with user/service pills, model-scope and expiry summary, a one-time migration notice plus a persistent "rotate" nudge for legacy keys, a scoped create form (name, user-vs-service, allowed models, expiry), permission-aware affordances, and graceful degradation in the four consumers that previously fed on raw keys (Quick connect, Home keys summary, cli-tools `ApiKeySelect`, CLI TUI).

Key judgment calls (ADR-0005 wins over the issue text where they differ):

- **No MITM key picker UI.** The issue scope line says "explicit instance setting that references a service key", but the approved ADR-0005 supersedes it: MITM gets a dedicated internal credential that is "never an `apiKeys` row, never shown in the UI". No settings row, no selector, no warning state in the MITM pages. MITM UI is untouched.
- **No new workspace-switch or feature-switch UI.** Handbook §6 forbids exposing the switch outside the release issue. All gating is server-driven (`isMultiUserEnabled()`, `requireMultiUser()`); the client learns the mode from the payload shape, not from a toggle.
- **Prefix-only also means no reveal and no copy buttons in list rows.** Keeping an eye/copy affordance next to a prefix would be dead UI; remove them when the switch is on, don't disable them.

## User Workflows

### Primary flows (switch ON)

1. **Create a key (member or manager).**
   - `/dashboard/endpoint` → "Create key" (or `?create=key`, command palette) → modal.
   - Fields: **Name** (existing validation, 64 chars, no control chars), **Key owner**: `Me` (default) or `Service` — the `Service` option renders only when the caller holds `workspace.keys.manage` in the target workspace (ADR-0002: member has `workspace.keys.create` only for own keys; manager+ has `workspace.keys.manage`), **Limit models** (optional; empty = all models in the workspace), **Expires** (`Never` default / 7 / 30 / 90 days / custom date).
   - Submit → success: modal closes, the existing one-time reveal banner appears inside the keys card: full key in a `dir="ltr"` mono block, "Copy key" primary action, dismiss button. This banner already exists (`CreatedBanner` in `ApiKeysCard.js`) and is the correct pattern — keep it verbatim, extend its copy to state the prefix.
   - Copy confirmation is announced via the existing `CopyStatus` polite live region.
2. **Recognize and manage keys in the list.**
   - Rows show: name (+ inline rename as today), **prefix** (`th_xxxx…yyyy`, mono, `dir="ltr"`), type pill (`User`/`Service`), owner (for service keys: workspace name; for user keys of others, visible to `workspace.keys.manage` holders only), scope summary (`All models` or `N models`), **Expires** (date, relative; `Expired` pill when past), `Legacy` pill on migrated `sk-` rows, Created / Last used / Today, pause toggle, delete.
   - **No eye icon, no copy icon** on rows when the switch is on. The prefix is the only identifier; renaming stays the way to make keys human-distinguishable.
3. **First switch-on launch (migration notice).**
   - After the in-place hash migration runs, the keys card shows a one-time notice (callout, dismissible): full keys are no longer stored or shown; existing keys keep working; only the prefix is displayed from now on. Dismissal is persisted server-side (see Open Questions for the storage choice) so it doesn't nag on every browser.
   - Independently of that one-time notice, every `legacy: true` row keeps a `Legacy` pill + a persistent callout above the table while at least one legacy key exists: "Legacy keys still work but are weaker. Create a new key and delete the old one." This is the ADR-0005 rotation nudge — it must not be one-time; it stays until no legacy keys remain.
4. **Revoke / pause / delete.**
   - Unchanged interactions (toggle + confirm dialog for pause, confirm dialog for delete). Server enforces ownership: a member's own keys are manageable by them; other users' keys require `workspace.keys.manage`; cross-workspace rows are 404 (invisible, not forbidden-looking).
5. **Lifecycle feedback.**
   - A user key whose user was disabled/deleted/left the workspace disappears from lists (it is revoked, not shown as a zombie). Service keys survive member churn — no UI event.
   - An expired key renders with an `Expired` pill and its toggle disabled; re-enabling is impossible without editing expiry — minimum: toggle disabled with a tooltip "This key expired".

### Alternative / edge flows

- **Create with no model restriction then regret:** edit of `allowedModels`/`expiresAt` after creation is _not_ in the minimum; recovery is "create a new key, delete the old one", which the UI copy should say in the delete-confirm for scoped keys. (Nice-to-have: an edit modal; see Recommendations.)
- **Duplicate names:** `duplicateKeyLabel` currently disambiguates with the raw key's last 4 (`…key.slice(-4)`). With hashed rows the last-4 comes from the stored **prefix** (last 4 is part of the prefix per ADR-0005), so the helper must switch from `key.key` to `key.prefix` — the disambiguation UX is preserved.
- **Quick connect with no revealable key:** when the switch is on and the selected key is not the just-created one, the snippet shows the placeholder mask and the "Copy snippet" button is disabled with helper text "Create a new key to copy a snippet — full keys aren't stored." When the just-created key is selected, the existing `revealed` plumbing already substitutes the plain key (`QuickConnectCard.js` lines 44, `quickConnectSnippets`) — keep that.
- **cli-tools `ApiKeySelect`:** today its options are raw keys (`{ value: k.key, label: k.key }`) and `src/lib/cliToolConfigs/shared.js` falls back to `apiKeys[0].key`. With prefix-only lists there is no usable value. Minimum: options show `name (prefix)`; selection is only actionable for the just-created key held in memory; otherwise the select shows a "Create an API key first" state linking to `/dashboard/endpoint?create=key`. Full preset redesign is YAN-374's job — do not rebuild it here.
- **CLI TUI:** "View Full Key" and "Copy Key to Clipboard" menu items disappear when the list payload has no `key` field; create flow prints the key once with the existing "Save this key now" warning (already implemented in `cli/src/cli/menus/apiKeys.js`). Delete/pause flows unchanged. With the switch off the menu is byte-identical.
- **Empty state:** unchanged copy ("No API keys yet…"), plus the auto-provisioned "Default Key" first-run path stays (it becomes a Default-workspace **service** key named "Default Key" server-side; the user sees no difference).

## UI/UX Best Practices

### Industry standards (grounded in what the codebase already does)

- **Show-once secret** — GitHub PAT / Stripe / OpenAI console pattern: full value rendered once post-creation with an explicit "won't be shown again" warning and a copy affordance. tokenhop already implements this (`CreatedBanner`, `KeysSummary` modal). YAN-363 makes the warning _true_ server-side; no new pattern needed.
- **Prefix identification** — GitHub (`ghp_…abcd`), Stripe (`sk_live_…xyzw`): show first-few + last-4. ADR-0005 fixes prefix = first 7 + last 4 → display `th_xxxx…yyyy` in mono, `dir="ltr"`, never truncated mid-prefix on desktop (mobile may truncate with ellipsis, prefix start is the identifying part).
- **Capability-driven chrome** — render only what the principal can do (ADR-0002: "YAN-371/373/376 build UI that hides what the capability map denies"). Member: no `Service` option, no other people's rows beyond what `workspace.keys.create` implies. Viewer: no Create button (viewer lacks `workspace.keys.create`), read-only list.
- **ARIA APG dialog pattern** (w3.org/WAI/ARIA/apg/patterns/dialog-modal): focus moves into the modal on open, Tab/Shift+Tab cycle inside, Escape closes, focus returns to the invoker. The shared `Modal` already does this via `useFocusTrap`/`useDismiss` — the extended create form must keep all new fields inside the existing trap and keep a visible close control. For the destructive delete confirm, focus starts on the least destructive action (existing `ConfirmDialog` behavior — keep).
- **Announcements:** keep `role="alert"` on the reveal banner, `CopyStatus` live regions on every copy button, `aria-invalid` + `aria-describedby` on the name field (all existing patterns — new fields must follow them).

### Accessibility

- All interactive elements reachable by keyboard: type radio, model multi-select, expiry select/date input must be native or fully keyboard-operable (`Select`, `Input`, `Toggle` primitives already are).
- Pills (`User`/`Service`/`Legacy`/`Expired`) are `StatusPill`s — text, not color-only. Expired uses the `warn` variant; Legacy uses `neutral` with a tooltip/title "Rotate recommended".
- The prefix `<code>` keeps `dir="ltr"` so RTL layouts don't scramble `th_`.
- Touch targets: existing `IconButton size-7` minimum is retained; no new icon-only buttons are added (prefix has none).
- Color contrast: reuse theme tokens (`text-muted`, `border-line`, `bg-raised`, `warn`/`err` tokens) — both themes already pass; no hardcoded colors.

### Responsive

- Desktop table ≥ `md` gains columns: Type, Scope, Expires. Order: Name · Key (prefix) · Type · Scope · Expires · Created · Last used · Today · On · Actions. Keep `overflow-x-auto` as today.
- Mobile stacked cards (`md:hidden`) gain one meta line: `Service · All models · Expires 12 Nov 2026` under the name, matching the existing `Created … · Last used … · N today` line style.
- Create modal stays single-column; custom-date input appears inline when "Custom date" is chosen. Minimum date = tomorrow (`min` attr), enforced server-side too.

## Error Handling

### Error states table

| Surface           | Trigger                                                                       | UX                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create modal      | Name blank/oversized/control chars                                            | Inline field error via existing `validateKeyName` literals ("Name is required" / "Name must be 64 characters or fewer" / "Name can't include control characters"); field stays open |
| Create modal      | 403 `workspace.keys.create` missing (viewer)                                  | Create button never renders; direct URL `?create=key` → modal replaced by inline callout "You don't have permission to create keys in this workspace."                              |
| Create modal      | 403 on `Service` type (member without `manage`)                               | Option hidden client-side; if forced via API, inline "You can't create service keys in this workspace."                                                                             |
| Create modal      | Invalid expiry (past date) / unknown model id                                 | Inline field error from the 400 `error` literal; no silent correction                                                                                                               |
| Create modal      | Server/network failure                                                        | Existing inline `createError` under the field (keep)                                                                                                                                |
| List load         | GET failure                                                                   | Existing page-level err callout + `WidgetError` with retry on Home (keep)                                                                                                           |
| Rename            | 400/403/404                                                                   | Existing per-row inline error, editor stays open (keep)                                                                                                                             |
| Toggle/delete     | 403 (member touching another user's key)                                      | Toast via `notifyError` with the server literal; row state unchanged (no optimistic updates — existing rule)                                                                        |
| Toggle/delete     | 404 (cross-workspace or revoked-elsewhere)                                    | Toast "API key not found" + list refresh                                                                                                                                            |
| Gateway (clients) | Missing key                                                                   | 401 `Missing API key` (unchanged literal)                                                                                                                                           |
| Gateway (clients) | Bad key                                                                       | 401 `Invalid API key` (unchanged literal — deliberately indistinguishable for unknown vs revoked, no existence oracle)                                                              |
| Gateway (clients) | Expired key                                                                   | 401 with a distinct, non-enumerating body: `This API key has expired`                                                                                                               |
| Gateway (clients) | Model not in `allowedModels` (with YAN-368)                                   | OpenAI-shaped error naming the restriction: "This key can't use model `<id>`"                                                                                                       |
| Local no-key      | `requireApiKey=false`, switch on, `multiUserActive=true` without admin opt-in | 401 explaining the refusal: "Unauthenticated local requests are disabled on multi-user instances. Use an API key."                                                                  |

### Validation patterns

- Client-side validation mirrors server literals exactly (existing `validateKeyName` shared by route and UI is the model to copy for expiry and model-list validation).
- Errors clear on edit (existing `setNewKeyName`/`clearRenameError` pattern).
- No optimistic updates anywhere in this feature: local state changes only after server confirm (existing `useApiKeys` rule — keep).

## Performance UX

- List responses stay small (prefix rows are _smaller_ than raw-key rows). No new polling; the existing fetch-on-mount + refresh-after-mutation pattern is enough.
- Creation is one POST; the reveal banner renders from the response body without a second fetch (existing `revealed` state — keep; extend it to carry `prefix`, `type`, `expiresAt` for the success copy).
- No skeleton changes: `LoadingState lines={3}` on endpoint, `WidgetSkeleton` on Home already cover the new columns.
- Offline: dashboard is localhost-first; a failed fetch already surfaces the err callout with retry on Home. No new offline handling.

## Competitive Analysis

| Product                  | Pattern worth copying                                                                                                       | What we avoid                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| GitHub fine-grained PATs | Show-once with strong warning; last-4 identification; expiration presets incl. custom date; per-token scope summary in list | Their huge permission matrix — our scoping is `allowedModels`/`allowedCombos` only |
| OpenAI API keys          | Service-account vs user key distinction; "Restricted" vs "All" permission pill                                              | Project picker sprawl — one workspace scope column only                            |
| Stripe keys              | `sk_live_…xyzw` prefix in every list; "Reveal" only for publishable keys, never for secret ones                             | Reveal-any-secret affordances — we have none post-hashing                          |
| LiteLLM Proxy UI         | User key dies with user, service key survives (handbook §2 — adopted)                                                       | Non-rotatable salt key; three-level ownership sprawl                               |
| OpenRouter               | Existing installs land in a Default workspace with zero manual steps (adopted: legacy keys → Default service keys)          | —                                                                                  |
| Cloudflare AI GW         | — (negative example)                                                                                                        | Tokens that can "run" anything: our per-key model restriction closes this          |

Best-in-class consensus the design follows: **show once, identify by prefix, scope at creation, expire by default-capable, revoke visibly, never offer re-reveal.**

## Component contracts and exact files

All changes behind the switch: switch OFF → byte-identical DOM, strings and API payloads. Client detects mode from payload: rows with a `prefix` field and no `key` field = hashed mode. No client reads `multiUserEnabled` directly for these surfaces.

### API payload contracts (server side, for the UI to consume)

- `GET /api/keys` — switch off: unchanged (`keys[].key` raw present). Switch on: `keys[] = { id, name, prefix, type: "user"|"service", userId: string|null, ownerLabel: string|null, workspaceId, allowedModels: string[], allowedCombos: string[], expiresAt: string|null, legacy: boolean, isActive, createdAt, lastUsed, requestsToday }`. **Never** `key`. Another workspace's keys are absent, not 403'd.
- `POST /api/keys` — accepts `{ name, type?, allowedModels?, allowedCombos?, expiresAt? }`. Switch off: unchanged request/response. Switch on: 201 `{ id, name, prefix, type, expiresAt, key: "<full th_…>" }` — the only response ever carrying the raw value. 400 literals for validation; 403 literals for capability failures.
- `PUT /api/keys/[id]` — switch on adds `{ expiresAt, allowedModels, allowedCombos }` to the existing `{ name, isActive }` (minimum: only if an edit affordance ships; otherwise keep name/isActive only).
- `DELETE /api/keys/[id]` — unchanged shape.
- Capabilities (`src/lib/auth/routePolicy.js` already maps them): GET → `workspace.keys.manage` OR own-rows filtered for `workspace.keys.create`; POST own → `workspace.keys.create`; POST service / PUT / DELETE others' → `workspace.keys.manage`.

### Files to modify (switch-gated, smallest diffs)

| File                                                                    | Change                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/(dashboard)/dashboard/endpoint/endpointLogic.js`               | `maskKey` gains a prefix path (`formatPrefix(prefix)` → `th_xxxx…yyyy`); `duplicateKeyLabel` reads `key.prefix` fallback when `key.key` absent; add `formatExpiry(expiresAt)` + `isExpired` helpers; add `validateExpiry` client check                                                                                                             |
| `src/app/(dashboard)/dashboard/endpoint/hooks/useApiKeys.js`            | `createKey` posts the extended body; `revealed` carries `{ id, name, plain, prefix, type, expiresAt }`; create-form state for type/models/expiry + their inline errors; derive `hashedMode` from first row (`'prefix' in row && !('key' in row)`)                                                                                                  |
| `src/app/(dashboard)/dashboard/endpoint/components/ApiKeysCard.js`      | New columns (Type/Scope/Expires) + pills; prefix rendering instead of mask/eye/copy when `hashedMode`; migration-notice callout (dismissible) + legacy-rotation callout; prop `capabilities: { canCreate, canManageService }`; PropTypes updated. **Switch off: current render untouched** — gate by `hashedMode` prop, not by deleting code paths |
| `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`          | Create modal gains Key-owner radio (conditional), Limit-models control, Expires select + custom date; wires new `useApiKeys` state; fetches capability hints from the keys payload meta (`canCreate`, `canManageService`) or a `?meta=1` field — exact source TBD with tech lane                                                                   |
| `src/app/(dashboard)/dashboard/endpoint/components/QuickConnectCard.js` | `hashedMode`: copy disabled + helper line when selected key isn't the revealed one; unchanged otherwise                                                                                                                                                                                                                                            |
| `src/app/(dashboard)/dashboard/home/KeysSummary.js`                     | `maskApiKey(key.key)` → prefix fallback; create modal gains optional expiry (minimum: keep name-only creation here, full scoping lives on the endpoint page — avoids duplicating the form); reveal modal unchanged                                                                                                                                 |
| `src/app/(dashboard)/dashboard/home/format.js` (`maskApiKey`)           | prefix-aware                                                                                                                                                                                                                                                                                                                                       |
| `src/app/(dashboard)/dashboard/cli-tools/components/ApiKeySelect.js`    | options labelled `name (prefix)`; no-raw-key state → "Create an API key first" link to `/dashboard/endpoint?create=key`; just-created key remains selectable                                                                                                                                                                                       |
| `cli/src/cli/menus/apiKeys.js`                                          | hide "View Full Key"/"Copy Key" items when rows lack `key`; create prompt adds optional expiry/service questions only when server advertises them in the create response meta; **switch off: menu byte-identical**                                                                                                                                 |
| `cli/src/cli/api/client.js`                                             | pass through new POST body fields; no auth changes                                                                                                                                                                                                                                                                                                 |
| `src/app/api/keys/route.js`, `src/app/api/keys/[id]/route.js`           | payload contracts above; `withUsage` joins switch from `k.key` to `apiKeyId` (ADR-0005) — UI-visible only through unchanged `lastUsed`/`requestsToday` fields                                                                                                                                                                                      |

### Files explicitly NOT touched (no scope creep)

- No MITM page/settings UI (internal credential is invisible per ADR-0005).
- No settings-section switch toggle (handbook §6).
- No `usageRepo` UI changes (YAN-370 owns usage views; joins change underneath).
- No workspace switcher/nav changes (YAN-371/376 own those).

## Browser validation plan (owner: this lane, run during implementation)

Setup: temp `DATA_DIR`; run twice — `TOKENHOP_MULTI_USER=off npm run dev` and `=on`, `PORT=20128`. Seed ≥3 keys incl. one duplicate name; switch-on run seeds a migrated legacy row (`legacy:1`, `sk-…` history) and one expired row.

**Switch OFF (regression, all must be pixel/behavior-identical to master):**

1. `/dashboard/endpoint`: mask + eye reveal + copy per row works; create → reveal banner; rename Enter/Escape; pause confirm; delete confirm; `?create=key` deep link.
2. `/dashboard/home` KeysSummary and `/dashboard/cli-tools` ApiKeySelect: raw-key options unchanged.
3. CLI `showApiKeysMenu`: "View Full Key" and "Copy Key" present and functional.

**Switch ON:**

1. List shows prefixes only; **no** eye/copy icons; full key appears in exactly one place (post-create banner); DevTools network: no response except POST contains a value matching `/^th_[A-Za-z0-9]{32}$/`; legacy row shows `Legacy` pill + rotation callout; expired row shows pill + disabled toggle.
2. Create matrix: member (own only, no Service option), manager (Service option), viewer (no Create button; deep link → permission callout); expiry presets + custom date; model restriction summary on the row.
3. Migration notice appears once, dismissal persists across reload; legacy callout persists until last legacy key deleted.
4. Quick connect: copy disabled with helper text for non-revealed keys; enabled for just-created.
5. cli-tools: prefix-labelled options; "Create an API key first" state when nothing usable.
6. CLI menu: no view/copy items; create prints key once.
7. Gateway errors: curl without key → `Missing API key`; wrong key → `Invalid API key`; expired key → expiry message; restricted model → model-restriction message.
8. **Keyboard-only** whole create/rename/pause/delete path incl. new fields (focus trap, visible focus rings, Escape everywhere).
9. **Themes** light + dark on every changed surface; **widths** 1440 / 1024 / 390 (mobile stacked cards incl. new meta line); **RTL** (`dir="rtl"` on root): prefix stays LTR, pills/logical spacing intact, no clipped actions.
10. Screen-reader spot check: banner announced (`role="alert"`), copy confirmed via live region, pill text read.

## Recommendations

### Must have (ship with YAN-363)

- One-time reveal banner kept and made truthful; prefix-only lists; no re-reveal/copy affordances in hashed mode.
- One-time migration notice + persistent legacy-rotation nudge.
- Scoped create form: name, owner type (capability-gated), allowed models (optional), expiry (optional).
- Capability-aware chrome (viewer/member/manager) and permission-error copy.
- `duplicateKeyLabel` and both mask helpers prefix-aware.
- cli-tools + Quick-connect + CLI graceful degradation states.
- Switch-off byte-parity proven by the validation plan above.

### Should have (same PR if cheap, otherwise follow-up)

- Edit expiry/allowed-models on an existing key (single "Edit limits" modal) — without it, recovery is delete-and-recreate, which is acceptable but lossy for embedded keys.
- `Expired` rows get a one-click "Duplicate as new key" action.
- Server-persisted migration-notice dismissal (vs localStorage).

### Nice to have (explicitly deferred)

- Key usage sparkline per row (belongs to YAN-370 usage views).
- Budget attach UI (`budgetId` is schema-only until YAN-372).
- Rotate-in-place (new secret, same row) — ADR-0005's nudge + create/delete is the sanctioned flow for v1.x.
- CLI key commands beyond the menu (YAN-377 owns `tokenhop keys rotate`).

## Open Questions

1. **Migration-notice dismissal storage**: instance setting (`apiKeyMigrationNoticeAckedAt`, dismissed once for the install) vs per-user (`users`-side pref doesn't exist yet) vs per-browser localStorage. Recommendation: instance setting — one line in `settings`, matches "one-time notice" in the issue, no new schema. Needs tech-lane confirmation.
2. **Capability hints to the client**: embed `canCreate`/`canManageService` in the `GET /api/keys` envelope (`{ keys, capabilities }`) vs a separate `/api/keys/capabilities` endpoint. Envelope field is one round-trip fewer; flagged for tech lane.
3. **Member list visibility**: does a member see other users' key rows (name/prefix/owner, no manage) or only their own + service keys? ADR-0002 grants `workspace.keys.manage` (list any) to manager+; `create`-only members should see own + service keys. Confirm with business lane — affects whether the list needs an `Owner` column filter.
4. **Expiry input granularity**: date-only vs datetime. Recommendation: date-only (UTC midnight), matching ADR-0007's UTC-day convention; datetime adds timezone UI for near-zero value on a self-hosted gateway.
5. **Custom-date minimum**: tomorrow vs today. Server should accept any future instant; UI presets cover the common cases.
6. **Legacy rotation nudge wording** must avoid promising a removal date ("a future release may stop accepting them" per ADR-0005) — final copy review with docs lane (YAN-379).
