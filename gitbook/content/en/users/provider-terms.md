# Provider Terms and Sharing

Why subscription logins (Claude Pro/Max, ChatGPT/Codex, GitHub Copilot Individual and similar) stay personal in tokenhop, what to share instead, and what happens when an admin shares one anyway.

> **This is not legal advice.** The terms below apply to **your own accounts** with each provider. tokenhop cannot grant you rights the provider has not given you, and it does not decide what your agreement allows. Provider terms change; quotes here were checked on **2026-10-20**. Read the current terms for your plan before you share anything. For the vocabulary used here (workspaces, connections, grants) see [Concepts](/en/users/concepts).

---

## The Short Version

- A **subscription login** (you sign in with a personal account, tokenhop stores the OAuth token) is meant for the person who bought it.
- An **API key** or a **business/team plan** with one seat per person is how a household or team shares access in a way providers expect.
- tokenhop therefore keeps subscription connections in the owner's personal workspace and **does not let them be shared by default**. Sharing one is a deliberate, warned and audited admin action.

---

## What the Providers Say

Quotes are copied from the pages named, **checked 2026-10-20**. Anything not quoted is our summary, not the provider's wording.

### Anthropic (Claude Pro, Max)

Consumer Terms of Service ([anthropic.com/legal/consumer-terms](https://www.anthropic.com/legal/consumer-terms), checked 2026-10-20), section 2:

> You may not share your Account login information, Anthropic API key, or Account credentials with anyone else. You also may not make your Account available to anyone else.

Section 3 also lists, among things you may not do:

> Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise.

Claude Code legal and compliance page ([code.claude.com/docs/en/legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance), checked 2026-10-20), "Authentication and credential use":

> Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users.

The same page says API keys are the route for products and shared use, and that it does not restrict customers provisioning their own API keys for their own authorized users, "provided the resulting usage is billed to the key owner under their agreement with Anthropic (or the applicable provider) and is not resold or intermediated as described above."

### OpenAI (ChatGPT, Codex with a ChatGPT plan)

Terms of Use ([openai.com/policies/terms-of-use](https://openai.com/policies/terms-of-use/), effective January 1, 2026, checked 2026-10-20), "Registration and access":

> You may not share your account credentials or make your account available to anyone else and are responsible for all activities that occur under your account.

The same page says "Our Business Terms govern use of ChatGPT Enterprise, our APIs, and our other services for businesses and developers."

Using Codex with your ChatGPT plan ([help.openai.com](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan), checked 2026-10-20), "Terms for using Codex":

> When you sign in to Codex using an existing ChatGPT account, the ChatGPT Terms of Use and Privacy Policy—or the corresponding online services agreement for OpenAI API and ChatGPT Enterprise, Education or Business Users—apply to data shared between Codex and ChatGPT.

### GitHub (Copilot Individual)

GitHub Terms of Service ([docs.github.com](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service), effective April 27, 2026, checked 2026-10-20), section B.3 "Account Requirements":

> Your login may only be used by one person — i.e., a single login may not be shared by multiple people. A paid Organization may only provide access to as many Personal Accounts as your subscription allows.

Plans for GitHub Copilot ([docs.github.com](https://docs.github.com/en/copilot/concepts/billing/individual-plans), checked 2026-10-20) lists Copilot Free, Student, Pro, Pro+ and Max as individual plans, and says of Copilot Business:

> Made for organizations and enterprises, this plan offers centralized management and Copilot policy control for organization members.

### Other providers

tokenhop has **not** reviewed the terms of other providers (Google, Cursor, Kiro and so on). Its warning for those says so and asks you to read the provider's terms first.

---

## What to Share Instead

| Instead of sharing...      | Share this                                                                  | Why                                                                             |
| -------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A Claude Pro/Max login     | An Anthropic **API key** connection, or give each person their own plan     | API keys are the provider-supported route for other people's use.               |
| A ChatGPT/Codex login      | An OpenAI **API key** connection, or a business plan with a seat per person | Business and API use sits under different terms from personal ChatGPT accounts. |
| A Copilot Individual login | **Copilot Business** seats: each person signs in with their own seat        | One login, one person. Organization plans are per seat.                         |
| Any other personal login   | An API-key connection, or one login per person                              | The same single-user logic applies.                                             |

In tokenhop, an **API-key connection** can be granted to a shared workspace or to one member without the override described below. tokenhop treats `anthropic`, `openai` and most other API-key providers as shareable.

If everyone brings their own subscription, nothing needs sharing: each person adds their own login to **their own workspace** and uses their own gateway key. A household where one person has Claude Max and another has ChatGPT Plus works this way. See [Concepts](/en/users/concepts) and [Teams](/en/users/teams).

---

## How tokenhop Treats Subscription Connections

### Not grantable by default

- Every provider in tokenhop is marked **shareable** or **personal**. API-key providers such as `anthropic` and `openai` are shareable. Subscription providers such as `claude`, `codex`, `github` (Copilot), `gemini-cli`, `cursor` and the flat-rate "coding plan" providers are personal.
- A connection that was added with **OAuth is always treated as personal**, even on a provider that is otherwise shareable. A provider tokenhop does not recognise is also treated as personal.
- A personal connection **cannot be granted** until an instance owner or admin changes the instance policy and accepts a warning for each share.
- The `github` provider is classified as personal as a whole. tokenhop does not distinguish a Copilot Business login from an Individual one, so any share of a `github` connection goes through the override below.

### The override: explicit, warned, audited

To share a personal connection, all of these must be true:

1. Users & teams is on.
2. An instance **owner or admin** turned on **Settings → Security & access → Allow sharing subscription connections** (off by default). The description there reads: "Lets owners and admins share subscription connections after accepting the provider terms warning. Most provider terms forbid account sharing."
3. The person sharing is an instance owner or admin. Workspace managers can share API-key connections, but not personal ones.
4. In the connection's **Share** dialog, the admin reads the **Provider terms apply** warning and ticks **I have read the warning above and accept the provider terms.** The checkbox stays disabled when the policy is off or the person is not an admin, and the server refuses a grant without the acknowledgement (403).

The server stamps the time of the acknowledgement on the grant and writes an audit event, `connectionGrant.create`; revoking a grant writes `connectionGrant.revoke`. Events hold ids and metadata only, never credentials. Admins can review them on **Watch → Audit log**.

The warning is specific to the provider family (Anthropic, OpenAI, GitHub, Google) with a generic version for all others. Each ends by saying overriding may violate that provider's terms. When you share, you accept that risk for your own accounts: tokenhop records the acknowledgement but does not make the share compliant.

A share can be limited to certain models, request and token rates, and a budget in the same dialog. See [Teams](/en/users/teams) for budgets and [Security](/en/users/security) for how credentials are stored.

---

## Checklist Before Sharing a Subscription

- [ ] I read the current terms for this exact plan, not a summary of them.
- [ ] No API-key or business-plan connection can do this job.
- [ ] Everyone using it is covered by the account holder's agreement as far as I can tell. If unsure, I will not share.
- [ ] I understand the provider may suspend the account, which affects everyone relying on it.

---

## Next Steps

- [Concepts](/en/users/concepts): workspaces, personal vs shared, connections
- [Teams](/en/users/teams): grants, budgets and members
- [Security](/en/users/security): encryption and backups
