# Users & Teams: Concepts

tokenhop can run as a single-user gateway, which is how it starts, or as a multi-user gateway for a household or a small team. This page explains the vocabulary: users, roles, workspaces, memberships, API keys, grants and budgets.

Next steps: [Households](/en/users/households), [Teams](/en/users/teams), [Security, keys and backups](/en/users/security), [SSO](/en/users/sso), [Provider terms](/en/users/provider-terms).

---

## Enabling Users & Teams

The **users & teams** switch is available from v1.1.0 and is **off by default**. While it is off, tokenhop behaves like a single-user install and none of the pages or APIs described in this section exist (they answer 404).

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
- **Every level counts.** A request must pass the key, user, member and workspace budgets, plus the grant budget when it is routed through a grant. If any level is over, the request is rejected.
- **Reservation before the call.** Before sending anything upstream, tokenhop estimates the request's cost and reserves it at every level. If the reservation does not fit, the client gets an HTTP `429` with an OpenAI-style error: `code: "budget_exceeded"`, plus the `level` and `window` that tripped. After the response, the reservation is replaced with recorded usage; if the request ends without recorded usage, the hold is released. The estimate uses input plus `max_tokens`, or a small fixed amount for models without pricing and non-token requests, so actual spend can exceed a limit. Budgets are tokenhop's own accounting, a guardrail, not a billing guarantee: for a hard cap, also set a spending limit at the provider.
- **Who can change what:** managers can add budgets and lower them. **Raising or removing** a limit needs an instance owner or admin. A key budget cannot exceed the workspace budget for the same window.
- Subscription traffic has no per-token bill. Its spend is shown as an estimate ("Notional spend … estimate, not billing").

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
