# Teams

A team shares one tokenhop server through a **shared workspace**: shared provider connections, roles for each person, budgets per member, and an audit trail. This page covers day-to-day setup and what happens when someone leaves.

Turn on users & teams first and back up your master key: see [Enabling users & teams](/en/users/concepts#enabling-users--teams) and [Security, keys and backups](/en/users/security). For vocabulary see [Concepts](/en/users/concepts). For small families see [Households](/en/users/households).

---

## The Shared Workspace

When users & teams is first activated, tokenhop creates a shared workspace named **Default**, owned by the instance owner. Your existing connections, combos and aliases are already in it, and your old API keys are service keys there. Most teams simply use Default.

Day to day, an instance owner or admin manages people under **Admin → Workspaces**. Select a workspace to see its **Members** and **Invitations**.

- **Add an existing user:** in **Members**, choose the user, a role and select **Add member**.
- **Invite someone new:** in **Invitations**, pick a **Role** (`Manager`, `Member` or `Viewer`), optionally enter an **Email**, select **Create invitation** and **Copy link**. The link is shown once, expires in seven days and works once. tokenhop does not send email, so deliver it yourself. If you set an email, the person must use that address.
- **Change a role or remove someone:** use the role selector and remove button on the member row. A workspace always keeps at least one active manager.
- **Map groups from your identity provider:** see [SSO](/en/users/sso). Memberships created that way are owned by the provider and are not edited by hand.

From a terminal on the host, the owner can do the same with `tokenhop workspaces list`, `tokenhop workspaces members <workspaceId>`, `tokenhop workspaces add-member <workspaceId> <userId> --role manager|member|viewer` and `tokenhop workspaces remove-member <workspaceId> <userId>`. These commands need users & teams on and a running server.

Roles are explained in [Concepts](/en/users/concepts#memberships-and-workspace-roles). In short: managers run the workspace, members use it and create their own keys, viewers only see usage.

---

## Shared Credentials

Teams share access the way providers expect: with **API keys** or **business-plan** credentials, one seat per person where the plan requires it.

1. Switch to the shared workspace with the **Workspace** menu in the sidebar.
2. Open **Providers**, pick the provider and paste the organization's API key (or sign in with the business account).
3. In the connect dialog, check **Connect to workspace** names the shared workspace. Only workspace managers can add connections.

Everyone in the workspace (except viewers) can then use that connection, subject to their own role and budgets.

### Sharing a connection with another workspace or one person

If a connection should be used outside the workspace that owns it, use a **grant**:

1. On **Providers**, select the **Share** icon on the connection. You must manage that connection's workspace.
2. Choose **Share with**: **A workspace** or **One member**.
3. Optionally limit models, set requests per minute and tokens per minute, and add a **Budget limit** with a window.
4. Select **Share**.

Recipients see the connection under **Shared with you**. Subscription logins (for example a personal Claude or ChatGPT login) are not shareable unless an owner or admin turns on **Allow sharing subscription connections** in **Settings → Security & access** and accepts the provider-terms warning. Prefer API-key or business-plan connections. Read [Provider terms](/en/users/provider-terms) first.

### Keys for automation

Managers can create **service keys** for CI, bots and shared tools: in **Endpoint & keys**, select **Create key** and choose **Service key** under **Key owner**. A service key belongs to the workspace, so it keeps working when people come and go. Members create their own user keys.

---

## Budgets per Member

Budgets turn a shared credential into something you can ration. Open **Usage → Budgets** in the workspace.

- **Workspace budget:** a ceiling for everything in the workspace.
- **Per member:** select **Add budget**, set **Scope** to `membership`, pick the **Member**, and set a **Cost limit (USD)**, **Token limit** and/or **Request limit** with a **Window**.
- **Per key and per grant:** the same dialog covers a single API key or a shared connection grant.
- **Per user across workspaces:** an owner or admin can choose **User** in **Budgets for** to cap one person everywhere.

A request must fit every level (key, user, member, workspace, grant). Before the request goes upstream, tokenhop reserves its estimated cost at each level; if any level is full, the client gets HTTP `429` with `budget_exceeded` naming the level. The estimate is settled to the real cost afterwards, so overshoot is small but not zero. Budgets are a guardrail, not a billing guarantee; for a hard cap, also set a spending limit at the provider. Details and the reset rules are in [Concepts](/en/users/concepts#budgets).

Managers can add and lower budgets. Raising or removing a limit needs an instance owner or admin. A key's budget cannot be larger than the workspace budget for the same window.

---

## Audit Log

The **Audit log** page (under **Watch**) records who changed what: user and member changes, invitations, API keys, grants, budgets and similar events. It is visible to workspace managers and to instance owners and admins, and it shows the workspace you have active.

- Columns: **Time**, **Actor**, **Action**, **Target**. Select a row for the before/after details.
- Filters: **Action prefix**, **Actor user ID**, **Target type**, **From** and **To**.

Audit entries never contain secrets. Only a fixed set of safe fields is stored, and token-like text is redacted. The log is append-only; entries are not edited or purged by the dashboard.

---

## Offboarding

Open **Admin → Users**, select the person, and pick the action that fits.

| Action                                                  | Sessions              | Their user API keys                                | Their connections and data                                                       |
| ------------------------------------------------------- | --------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Disable**                                             | Ended immediately     | Revoked. **Enabling again does not restore them.** | Nothing is deleted. The account just cannot sign in or use keys.                 |
| **Remove member** (in the workspace's **Members** list) | Unchanged             | Revoked **in that workspace only**                 | Their shared contributions stay in the workspace                                 |
| **Delete user**                                         | Ended                 | Deleted with the account                           | Their **personal workspace and its connections are deleted**. Shared data stays. |
| **Sign out everywhere**                                 | Ended on every device | **Keep working**                                   | Unchanged                                                                        |

Things to know:

- **Service keys survive.** Keys owned by the workspace, not a person, keep working. If the person knew a service key, rotate it: create a new one, update your tools, delete the old one.
- **Shared connections stay.** Connections a person added to a shared workspace belong to the workspace. After the person is deleted, the "created by" link is cleared but the connection keeps working. Personal connections never leave their personal workspace by themselves, so anything the team still needs must be [moved](#moving-connections-and-keys-between-workspaces) out before you delete the person.
- **Usage history stays**, unattributed to the removed account.
- **The owner cannot be disabled or deleted.** Transfer ownership first (**Admin → Users → Transfer ownership**, or `tokenhop users transfer-owner <id>`).
- **Last manager rule:** you cannot disable, delete or remove the only manager of a shared workspace. Promote someone else first.
- **SSO users:** disable or delete the account in **Admin → Users** as well as in your identity provider, so the tokenhop account and its keys are dealt with explicitly.
- **Temporary password:** to hand an account over or recover it, use **Set temporary password**. It is shown once and the person must change it at next sign-in.

From a terminal the owner can run `tokenhop users disable <id>`, `tokenhop users enable <id>`, `tokenhop keys list` and `tokenhop keys revoke <id>`.

---

## Moving Connections and Keys Between Workspaces

You can move items from one workspace to another instead of re-creating them. Typical uses: promote a connection from someone's personal workspace into the team workspace, or hand a key to another workspace.

You can move provider connections, provider nodes, combos, aliases, custom models, disabled-model entries and API keys. Look for **Move to workspace** on the item (on the connection or key row, or on a combo).

1. Select **Move to workspace**, then choose the target in **Move to**.
2. tokenhop shows a preview. Clashes (a same-named combo, an account the target already has, and similar) **block** the move: rename something or move fewer items and preview again.
3. Warnings need your acknowledgement (**I understand these changes**), then select **Move** (or **Move and apply changes**).

Rules and effects:

- **You must be an active member of both workspaces** and hold the management right for that kind of item in both: connections and nodes need connection management, combos and aliases need combo management, API keys need key management. Instance admin status does not bypass this. For a manager of the team workspace to move someone's personal connection, that person has to do the move themselves.
- **All or nothing.** If anything fails, nothing moves.
- **Credentials are re-encrypted** for the target workspace and are never shown.
- **Active grants on a moved connection are revoked.** Share it again from the new workspace if needed.
- **Subscription logins moved into a shared workspace** show a provider-terms warning. See [Provider terms](/en/users/provider-terms).
- A **provider node** can only move together with every connection that uses it. If either is left behind, the move is blocked; select the node and all its connections in the same move.
- A **combo** that points at items that stay behind produces a warning. Move the referenced items too if they should follow.
- **API keys keep their identity.** The key value does not change, and a key budget moves with it. The target workspace's budget ceiling still applies.
- **Usage history stays** in the workspace where it happened.

---

## See Also

- [Concepts](/en/users/concepts)
- [Households](/en/users/households)
- [Security, keys and backups](/en/users/security)
- [SSO](/en/users/sso)
- [Provider terms](/en/users/provider-terms)
