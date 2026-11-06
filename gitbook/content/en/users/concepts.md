# Users & Teams: Concepts

tokenhop can run as a single-user gateway, which is how it starts, or as a multi-user gateway for a household or a small team. This page explains the vocabulary: users, roles, workspaces, memberships, API keys, grants and budgets.

Next steps: [Households](/en/users/households), [Teams](/en/users/teams), [Security, keys and backups](/en/users/security), [SSO](/en/users/sso), [Provider terms](/en/users/provider-terms).

---

## Enabling Users & Teams

The **users & teams** switch is available from v1.1.0 and is **off by default**. While it is off, tokenhop behaves like a single-user install and none of the pages or APIs described in this section exist (they answer 404). Exception: **Usage → Budgets** works without it, for workspace and API-key budgets (see [Budgets](#budgets)).

To turn it on:

1. **Back up your master key first.** Turning the switch on activates credential encryption and hashed API-key storage. Read [Security, keys and backups](/en/users/security).
2. Turn it on in one of two ways:
   - **Dashboard:** as the owner or an instance admin, open **Settings → Instance** and turn on **Users & teams**. tokenhop asks you to confirm and lists what changes.
   - **Environment variable:** set `TOKENHOP_MULTI_USER=on`. The variable overrides the dashboard. While it is set, the dashboard toggle is locked and shows "Set by TOKENHOP_MULTI_USER".
3. **Restart tokenhop the first time.** First activation backs up your data, hashes API keys and encrypts credentials, and that only happens at startup. Until you restart, the toggle shows that a restart is pending and tokenhop stays single-user.

Valid values for the variable are `on` and `off`. Any other value stops tokenhop at startup.

After the first activation, the dashboard toggle takes effect immediately, with no restart. Turning users & teams **off** never deletes anything. Users, workspaces and memberships are kept, and they come back when you turn it on again. While it is off, only the owner and instance admins can use the dashboard. Other users' sessions stop working, so the dashboard warns you when more than one user or a shared workspace exists. API keys stay hashed and credentials stay encrypted.

Config export/import and backup restore never change the switch. It changes only through the dashboard toggle or the environment variable.

On first activation tokenhop creates:

- an **owner** account from your existing admin password (username `owner`),
- a personal workspace for the owner, and
- a shared workspace named **Default**, owned by the owner. Existing provider connections, combos and aliases move into it. Existing API keys become **service keys** in Default, so your clients keep working without changes.

After that the sign-in page asks for **Email or username** plus password. For the full upgrade notes see [Upgrading](/en/upgrading).

---

## The Model at a Glance

```text
instance (one tokenhop server)
 ├─ users ............ owner | admin | user | pending
 │   └─ personal workspace (one per user, only that user is a member)
 └─ shared workspaces  (for example "Default")
     ├─ memberships ... owner | manager | member | viewer
     ├─ connections ... provider accounts and API keys
     ├─ combos, aliases, custom models
     ├─ API keys ...... user keys and service keys
     └─ budgets ....... workspace, member, key, grant (and user)

request:  API key ─► workspace ─► that workspace's connections (+ grants)
                       │
                       └─ budget check at key → user → member → workspace → grant
```

Every provider connection, combo and API key belongs to exactly one workspace. A key can only use the connections of its own workspace, plus connections that were explicitly shared with it through a grant.

---

## Users and Instance Roles

A **user** is a person with an account. A user can sign in with a password, with SSO, or both. The instance role controls what the user can do across the whole instance.

| Role                 | What it can do                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Owner**            | Everything an admin can do, plus transferring ownership and rotating the master key. There is exactly one owner.                                                                               |
| **Admin**            | Manages users, shared workspaces, SSO and instance settings, runs host operations, raises budgets and reads the audit log. Admins manage; they do not use other people's personal connections. |
| **User**             | Works in their own workspaces. This is the normal role.                                                                                                                                        |
| **Pending approval** | Has signed in but can do nothing until an owner or admin approves the account. New SSO sign-ins land here by default.                                                                          |

Only the owner can promote someone to admin or demote an admin. The owner account cannot be disabled or deleted; hand over ownership first. Users are managed in **Admin → Users**.

Instance roles and workspace roles are separate. Being an admin does not make you a member of anyone's workspace.

---

## Workspaces

A workspace is a container for connections, combos, keys and budgets.

| Kind         | Who is in it                  | Typical use                                              |
| ------------ | ----------------------------- | -------------------------------------------------------- |
| **Personal** | Only its owner. One per user. | Your own subscriptions and your own keys.                |
| **Shared**   | People you add or invite.     | A household or team. The first one is named **Default**. |

Personal workspaces are created automatically for every user and are named after the person. You switch between workspaces with the **Workspace** menu in the sidebar. Personal entries show `(personal)` after the name.

Admins cannot use the connections in someone else's personal workspace or read their secrets. Subscription logins connected there stay private to their owner unless the owner or an admin deliberately shares one (see [Provider terms](/en/users/provider-terms)).

---

## Memberships and Workspace Roles

A **membership** puts a user into a shared workspace with a role.

| Role        | Can do in that workspace                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Owner**   | Same rights as a manager. Managers cannot change or remove the owner.                                                                             |
| **Manager** | Manage members, connections, grants, API keys, combos and preferences. Read the audit log. Add or lower budgets. Use the workspace's connections. |
| **Member**  | Use the workspace's connections, create their own API keys, see usage and budgets.                                                                |
| **Viewer**  | See usage and budgets only. Cannot use connections or create keys.                                                                                |

Invitations can grant `manager`, `member` or `viewer`. Granting `manager` needs a workspace owner or an instance admin. A shared workspace always keeps at least one active manager: changes that would remove the last one are refused.

If SSO group mapping created a membership, the identity provider owns it and the dashboard will not edit it by hand. See [SSO](/en/users/sso).

---

## API Keys

Gateway API keys are what your tools send as the bearer token. Manage them under **Endpoint & keys**.

- **Format:** new keys look like `th_` followed by 32 random characters.
- **Shown once:** when you create a key, tokenhop shows it once in a banner ("Copy it now, it won't be shown again") with a **Copy key** button. After that only a **prefix** is stored and shown, such as `th_AbCdEfG…WxYz`. tokenhop cannot show the full key again, so create a new one if you lose it.
- **Hashed storage:** the server keeps a keyed hash, not the key. Losing the master key makes key validation impossible, which is why you should back it up. See [Security](/en/users/security).
- **Legacy keys:** keys from before users & teams still work. They carry a **Legacy** tag and a reminder to rotate: create a new key and delete the old one.

### User keys and service keys

| Type        | Owner                  | When the person is removed                                  |
| ----------- | ---------------------- | ----------------------------------------------------------- |
| **User**    | One person             | **Dies with them** (see below)                              |
| **Service** | The workspace, no user | **Survives** member changes. Only managers can create them. |

In the **Create API key** dialog the **Key owner** choice (`Me (user key)` or `Service key`) appears only if you are a manager. Members always create a user key.

A user key stops working when its owner is disabled, removed from the workspace, or deleted. Revocation is permanent: re-enabling the person does not bring their old keys back. Service keys are not tied to anyone. Use them for CI jobs, shared bots and anything that must outlive a team member.

Keys can also be limited to certain models or combos, given an expiry (7, 30 or 90 days, or a custom date), and given a spend limit. The list groups keys as **My keys**, **Workspace service keys** and **Other users' keys**. Managers see the last group.

---

## Grants

A **grant** lets a connection be used outside its own workspace. Use it to share one connection with another workspace, or with one member, without moving it.

- Create one from the **Share** action on a connection (**Providers**). Choose **A workspace** or **One member**.
- Optionally restrict models, set requests per minute and tokens per minute, and attach a budget with a window.
- API-key connections to providers marked shareable, such as Anthropic and OpenAI API keys, can be shared by a workspace manager.
- **Subscription logins are not shareable by default.** OAuth logins always count as subscription-bound. An owner or admin must turn on **Allow sharing subscription connections** under **Settings → Security & access** and then accept a provider-terms warning for each share. Read [Provider terms](/en/users/provider-terms) before you do.
- Recipients see shared connections in **Shared with you** on the Providers page.
- Moving a connection to another workspace revokes its active grants. See [Teams](/en/users/teams).

---

## Budgets

A **budget** caps cost, tokens or requests for a time window. You manage them in **Usage → Budgets**.

| Level         | Applies to                                      |
| ------------- | ----------------------------------------------- |
| **API key**   | One key                                         |
| **User**      | One person, across all their keys (admins only) |
| **Member**    | One person inside one workspace                 |
| **Workspace** | Everything in the workspace                     |
| **Grant**     | Traffic routed through one shared connection    |

- **Windows:** daily, weekly or monthly on UTC calendar boundaries, or total (never resets).
- **Limits:** cost in USD, tokens, requests. A budget needs at least one. An optional **soft limit** percentage only warns.
- **Notices:** tokenhop sends one notice per budget per window when spend crosses the soft limit, and one when the budget first rejects a request. A rejection can happen before the limit is fully spent, because the check counts the request's estimate and requests still in flight, so smaller requests may still pass until the window resets. People who can see the budget get a toast while the Usage page is open, and **Usage → Budgets** marks the budget **Soft limit reached** or **Limit hit** until the window resets. Each notice is also recorded in the audit log. A restart or a backup restore does not repeat a notice in the same window, unless the restore changes the budget's limits: like any limit change, that re-arms its notices. Changing the budget's limits or soft limit percentage during a window re-arms its notices, so they can fire again for the new limits.
- **Webhook:** each workspace can also send its notices to one URL of your own. See [Budget webhook](#budget-webhook) below.
- **Every level counts.** A request must pass the key, user, member and workspace budgets, plus the grant budget when it is routed through a grant. If any level is over, the request is rejected.
- **Reservation before the call.** Before sending anything upstream, tokenhop estimates the request's cost and reserves it at every level. If the reservation does not fit, the client gets an HTTP `429` with an OpenAI-style error: `code: "budget_exceeded"`, plus the `level` and `window` that tripped. After the response, the reservation is replaced with recorded usage; if the request ends without recorded usage, the hold is released. The estimate uses input plus `max_tokens`, or a small fixed amount for models without pricing and non-token requests, so actual spend can exceed a limit. Budgets are tokenhop's own accounting, a guardrail, not a billing guarantee: for a hard cap, also set a spending limit at the provider.
- **Who can change what:** managers can add budgets and lower them. **Raising or removing** a limit needs an instance owner or admin. A key budget cannot exceed the workspace budget for the same window.
- **Without Users & teams:** the dashboard admin can set **Workspace** and **API key** budgets on the Default workspace. Enforcement and the 429 are the same. User, member and grant budgets need Users & teams. Turning it on later keeps these budgets. Once accounts exist, an owner or admin needs a membership in Default to manage them. With login turned off, only workspace budgets can be added from the dashboard (API key budgets need a signed-in session).
- **Moving budgets:** the config export (**Settings → Data & backup**) carries the Default workspace's budgets: workspace, API key, member and grant budgets, or only workspace and API key budgets while Users & teams is off. A workspace export carries only that workspace's own budget. Both carry limits only, never spend or notices. On import, a budget whose key, member or grant doesn't exist on this instance is skipped and listed in the import preview; it is never attached to something else. In a config import, a budget that matches an existing one (same level, target and window) is updated in place, and an API key budget above the workspace budget for its window is skipped unless it raises an existing key budget (the same rule as **Usage → Budgets**). A workspace import never merges: if the destination already has a workspace budget for that window, the whole import is refused (`TRANSFER_CONFLICT`). Invalid limits fail the whole import; unknown fields in a budget entry are ignored with a warning. Files from older versions, which have no budgets, import as before. A full instance backup carries every budget while Users & teams is on, and the Default workspace's workspace and API key budgets while it is off (limits only, never spend or notices). Restoring an older backup that has no budgets keeps the current budgets while Users & teams is on, or with plain (legacy) key storage; with Users & teams off and hashed keys, it removes them. Budget webhooks are never included in a config, workspace or instance export.
- **Deleting a key:** deleting an API key without Users & teams (legacy key storage) also deletes its budgets, and each removal is recorded in the audit log. Once keys use hashed storage (Users & teams), deleting a key revokes it and keeps its budgets.
- **Restores:** restoring a backup removes budgets whose target the restore replaced: API key, grant, member and user budgets whose key, grant, membership or user no longer exists. Each of these removals is recorded in the audit log. A backup made while Users & teams is off also replaces the Default workspace's workspace and API key budgets: those it doesn't have are removed, and each removal is recorded in the audit log. Restoring an older backup that has no budgets with Users & teams off and hashed keys removes them through the workspace replace, without an audit entry per budget (see above). Restoring an instance snapshot that carries users & teams data (format v2 or v3) removes every budget webhook; add them again afterwards. A legacy (v1) snapshot restore leaves them in place.
- Subscription traffic has no per-token bill. Its spend is shown as an estimate ("Notional spend … estimate, not billing").

### Budget webhook

A workspace can have one optional webhook, set in **Usage → Budgets** below the budget list. tokenhop sends it a signed `POST` for the same two events as the notices above: the soft limit crossing and the first rejection, once per budget per window. A restart does not resend them. Changing a limit or the soft limit % inside the window re-arms the notice, and the next crossing is sent with a new `id`.

- **Who manages it:** with Users & teams on, the workspace's owners and managers (an instance owner or admin needs a membership in the workspace). With Users & teams off, the dashboard admin, for the Default workspace. Every change is recorded in the audit log.
- **Signing secret:** tokenhop creates a secret (`whsec_…`) when you add the webhook and shows it **once**. Copy it then. **Rotate secret** replaces it at once; the old secret stops working. Once credential encryption is active (it is turned on with Users & teams; see [Security](/en/users/security)), the secret is encrypted at rest; until then it is stored like other provider credentials. It never appears in API responses, logs, audit entries or exports.
- **Enabled:** turn the webhook off to pause sending without losing the URL or secret.

The request body is JSON:

```json
{
  "type": "budget.soft_limit",
  "id": "<budgetId>:soft:<windowStart>:<12 hex>",
  "budgetId": "…",
  "workspaceId": "…",
  "scope": { "type": "workspace", "id": "…" },
  "window": "day",
  "windowStart": "2026-11-05T00:00:00.000Z",
  "resetAt": "2026-11-06T00:00:00.000Z",
  "limits": { "usd": 10, "tokens": null, "requests": null },
  "spent": { "usd": 8.1, "tokens": 0, "requests": 12 },
  "threshold": { "percent": 80 },
  "timestamp": "2026-11-05T14:02:11.000Z"
}
```

`type` is `budget.soft_limit` or `budget.hard_limit` (the first rejection). `threshold.percent` is the budget's soft limit percentage for a soft notice and `100` for a hard one. `resetAt` is `null` for a total budget.

Headers:

- `x-tokenhop-signature: t=<unix seconds>,v1=<hex>`, where `v1` is the HMAC-SHA256 of `<t>.<raw body>` keyed with the signing secret.
- `x-tokenhop-webhook-id`: the same value as the body `id`. It stays the same across retries of one notice, so use it to drop duplicates. A notice re-armed by a limit or soft % change gets a new `id`.

To verify a request in Node, use the raw body exactly as received:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(signatureHeader.split(",").map((p) => p.split("=", 2)));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const given = Buffer.from(parts.v1 ?? "", "hex");
  const want = Buffer.from(expected, "hex");
  return given.length === want.length && timingSafeEqual(given, want);
}
```

Delivery:

- Sending never slows down or blocks gateway requests: it runs in the background after the notice is recorded.
- Up to 3 attempts: the first immediately, the second 2 seconds after the first fails, the third 10 seconds after that. Each attempt (DNS lookup, connect and response) has a 5 second deadline. Any `2xx` is success. DNS failures, network errors, timeouts, `5xx`, `408` and `429` are retried; `3xx` and other `4xx` are not. Redirects are never followed.
- A delivery still pending when tokenhop stops is dropped.
- Failures are logged with the destination host only, never the full URL or the secret.

Allowed destinations:

- By default only `https` URLs on the public internet. URLs with a username, password or `#fragment` are refused. Saving checks the URL itself: scheme, a literal IP or blocked host name, and userinfo. Before each attempt tokenhop resolves the host name and checks every address it returns; one blocked address refuses the attempt.
- An instance owner or admin can turn on **Settings → Security & access → Budget webhooks: allow private networks** to also allow private addresses (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`), loopback and `localhost`, IPv6 unique local addresses, and plain `http`.
- Link-local addresses (`169.254.0.0/16`, `fe80::/10`) and cloud metadata endpoints (`169.254.169.254`, `100.100.100.200`, `fd00:ec2::254`, `fd20:ce::254`, `fd00:c1::a9fe:a9fe`, `metadata.google.internal`, `metadata.goog`, `metadata`, `instance-data`) are always blocked, even with that setting on.

Webhooks are not part of any export. Restoring an instance snapshot that carries users & teams data (format v2 or v3) removes them; a legacy (v1) restore leaves them.

---

## Sign-in and Sessions

- **Sign out** (account menu) ends only the current browser session. Your other devices stay signed in.
- **Sign out everywhere** ends every session on every browser and device. It is also under **Settings → My account**, which lists your signed-in devices.
- An admin can use **Sign out everywhere** on a user's page in **Admin → Users**. That ends their browser sessions only; their API keys keep working.
- Disabling a user, changing their role or changing their password also ends their sessions.

---

## Where to Go Next

- Family setup: [Households](/en/users/households)
- Shared team setup, audit log and offboarding: [Teams](/en/users/teams)
- Encryption, master key backup, export and import: [Security, keys and backups](/en/users/security)
- Sign-in with an identity provider: [SSO](/en/users/sso)
- Which logins you may share: [Provider terms](/en/users/provider-terms)
