# Households

A household setup lets everyone in the family use one tokenhop server while each person keeps their own provider logins, their own API key and their own limits.

You need users & teams turned on first. See [Enabling users & teams](/en/users/concepts#enabling-users--teams) and back up your master key as described in [Security, keys and backups](/en/users/security). Terms used below are explained in [Concepts](/en/users/concepts).

---

## How It Fits Together

```text
Parent (owner)                Kid (user)
 ├─ personal workspace         ├─ personal workspace
 │   └─ own subscription       │   └─ own subscription
 └─ Default (shared)  ◄────────┘  member of Default
```

- **Everyone brings their own subscriptions.** A logged-in subscription (Claude, ChatGPT/Codex, Copilot and so on) is connected inside that person's **personal workspace** and stays private to them.
- **Everyone gets their own API key**, so usage and limits are tracked per person.
- **One person administers.** The owner (or an admin) approves accounts, invites people and sets limits.

Do not paste one person's subscription login into someone else's account, and do not share a subscription through tokenhop to avoid buying a second seat. Most providers forbid it. See [Provider terms](/en/users/provider-terms).

---

## 1. Invite Each Person

The owner invites people into the shared **Default** workspace.

1. Open **Admin → Workspaces** and select **Default**.
2. In **Invitations**, choose a **Role** (`Member` is right for most people) and optionally enter the person's **Email**.
3. Select **Create invitation**, then **Copy link**. The link is shown once and cannot be recovered, so send it right away. tokenhop does not send email.
4. The person opens the link, chooses **Create your account** (or signs in with SSO if you set it up, see [SSO](/en/users/sso)), and then signs in normally.

Invitation links are single-use and expire after seven days. If an invitation was bound to an email address, the person must use that address. Revoke an unused link from the same panel.

Each new account gets its own personal workspace automatically.

If someone signs in with SSO without an invitation, the account starts as **Pending approval**. Approve it in **Admin → Users** (**Approve as user**).

---

## 2. Connect Your Own Subscriptions

Each person does this for themselves, signed in to their own account.

1. Use the **Workspace** menu in the sidebar and choose your personal workspace (it shows `(personal)`).
2. Open **Providers**, pick a provider and sign in, or paste an API key.
3. If you can manage more than one workspace, the connect dialog shows **Connect to workspace**. Check that it says your personal workspace.

By default, subscription (OAuth) logins are connected to the personal workspace and API-key connections to **Default**. The dialog always names the target, so check it before you save.

Nobody else, including the owner and admins, can use a connection in your personal workspace.

---

## 3. Get Your Own API Key

Each person creates their own key.

1. Open **Endpoint & keys** and select **Create key**.
2. Give it a name. Optionally limit which models or combos it can use, set a **Spend limit (USD, optional)** with a **Spend window**, and choose an expiry.
3. Select **Create** and copy the key from the banner. It is shown once.

Members create **user keys**. They stop working if the person is disabled or removed. See [API keys](/en/users/concepts#api-keys).

---

## 4. Set Up Your Tools With "Copy Config"

Tools such as Claude Code, Codex or Cline run on your own computer, not on the tokenhop server. **CLI tools** gives you the settings to paste there.

1. Open **CLI tools** and pick your tool.
2. Pick or type a model.
3. Provide a key: paste one you already have, or select **Create my key** to make a personal key in your workspace.
4. Select **Copy config** and paste the result into the tool's config on your machine.

A key made with **Create my key** is shown only on that page and is not saved. Copy the config before you leave or refresh. The config contains your key, so treat it like a password.

If you are using the tokenhop host machine itself as the owner or admin, you will see **Apply on this machine** instead. Members without host access only see **Copy config**. Tool-specific steps are in the pages under Integration, for example [Claude Code](/en/integration/claude-code).

---

## 5. Set Limits for Kids' Keys

Limits are called budgets. Raising or removing a limit needs an instance owner or admin, so a child cannot lift a cap a parent set.

**Cap everything a person uses.** A per-person limit is the simplest way to keep a child within an allowance, because it still applies if they create a new key:

1. Open **Usage → Budgets**. Only an owner or admin sees the **User** target below.
2. In **Budgets for**, choose **User**, then pick the child.
3. Select **Add budget**, set a **Cost limit (USD)**, **Token limit** or **Request limit**, pick a **Window** (daily, weekly, monthly or total), and save. The **Soft limit (%)** field is optional and only warns.

The limit covers all of that person's keys. Meters show how much of the current window is left.

**Cap a single key.** When you create a key you can enter a **Spend limit** and window right in the **Create API key** dialog. Use this for a key you hand to an app or a device.

**What the child sees.** When a limit is reached, requests fail with HTTP `429` and a message such as `Budget exceeded at user level: …`. Daily, weekly and monthly windows reset on UTC boundaries, so the reset time may not match local midnight.

Budgets are checked before each request goes upstream, using an estimated cost (input plus `max_tokens`) that is settled to the real cost afterwards. Overshoot is small but not zero, so budgets are a guardrail, not a billing guarantee. For a hard cap, also set a spending limit at the provider. See [Budgets](/en/users/concepts#budgets).

Tip: give kids the **Member** role in Default, not **Manager**. Managers can change members, keys and connections in that workspace.

---

## When Someone Leaves the Household

Open **Admin → Users**, select the person, and choose **Disable**. Their sessions end and their API keys are revoked at once. Enabling the account later does **not** restore the old keys, so they create new ones. **Delete user** removes the account and its personal workspace. Details are in [Teams: offboarding](/en/users/teams#offboarding).

---

## See Also

- [Concepts](/en/users/concepts)
- [Teams](/en/users/teams)
- [Security, keys and backups](/en/users/security)
- [SSO](/en/users/sso)
- [Provider terms](/en/users/provider-terms)
