# Single Sign-On (OIDC and SAML)

Let people sign in to tokenhop with your identity provider (IdP), and map IdP groups to instance roles and workspaces. This page walks through authentik as a worked example, then lists the exact settings for generic OIDC and SAML.

> **Group and workspace mapping needs users & teams on.** The mapping described here (allowed groups, admin groups, group → workspace, pending approval) only runs when the users & teams switch is on: `TOKENHOP_MULTI_USER=on` (available from v1.1.0 and off by default). With the switch off, SSO is plain sign-in for the single admin. See [Concepts](/en/users/concepts) for the vocabulary (instance roles, workspaces, memberships).

---

## How SSO Sign-In Works

1. A person clicks the SSO button on the login page. tokenhop sends them to your IdP.
2. The IdP returns a verified identity: issuer plus subject (OIDC `sub`, or the SAML NameID) and, usually, an email and a list of groups.
3. tokenhop finds the account linked to that `(issuer, subject)` pair. **It never links accounts by email alone.**
4. A first-time identity becomes a new account. It starts as **Pending approval** unless the default role is set to **User**, and an admin approves it (see [Pending approval](#pending-approval)).
5. On every login the groups are re-read and the role and workspace memberships are re-synced.

---

## Worked Example: authentik (OIDC)

### 1. Create the provider

In authentik, create an OAuth2/OpenID provider (and an application that uses it):

- **Client type:** confidential. Note the **Client ID** and **Client Secret**.
- **Redirect URI:** a strict match for `https://tokenhop.example.com/api/auth/oidc/callback`. Use your real public URL.
- **Signing Key: select a certificate. This is required.** Pick any available certificate-key pair (authentik ships a self-signed one).

### Why the signing key matters

When no signing key is selected, authentik signs id_tokens with `HS256` and the provider's client secret. It publishes no public key (JWKS) for them. The behavior in tokenhop depends on the build:

- **Current builds** verify `HS256`, `HS384` and `HS512` id_tokens against the client secret, but only if the IdP's discovery document lists that algorithm in `id_token_signing_alg_values_supported` (when discovery lists nothing usable, only asymmetric algorithms are accepted). Unsigned (`alg: none`) tokens are always rejected, and the login nonce is always checked. Sign-in works.
- **Older builds** only accepted asymmetric signatures and failed to log in with authentik's default `HS256` tokens.

Even on a current build, select a signing key. Settings → Single sign-on → **Test sign-in** warns when the provider offers only `HS*` and recommends an `RS256` key. An asymmetric key also keeps working if the client secret is rotated.

### 2. Add a groups scope mapping

authentik sends no groups claim by default. Create a **scope mapping** with scope name `groups` and this expression:

```python
return {"groups": [group.name for group in request.user.all_groups()]}
```

`all_groups()` includes parent groups. Use `user.groups.all()` instead to send direct memberships only. Then:

- Add the mapping to the provider's **Scopes**.
- Add `groups` to tokenhop's **Scopes** field (next step), because the client must request the scope or authentik will not return the claim.

tokenhop reads the claim from the id_token first. If the claim is absent, it calls the UserInfo endpoint with the access token and reads it there. Two ways to make this work with authentik:

- Enable **Include claims in id_token** on the provider, so the groups arrive in the id_token. authentik otherwise returns scope-mapping claims from UserInfo only.
- Or leave it off and keep the UserInfo endpoint reachable. The UserInfo reply must carry the same `sub` (and `iss`, if present) as the id_token, with a 5 second timeout.

**Always send the claim, even for users with no groups.** If the claim is missing or malformed in both places, the login is refused with "Your sign-in provider did not send group information", even when no group restrictions are configured. An empty list is fine.

### 3. Configure tokenhop

Open **Settings → Single sign-on**:

| Field                     | Value                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| Protocol                  | OIDC                                                                |
| Issuer URL                | `https://auth.example.com/application/o/<slug>/`                    |
| Client ID / Client secret | From the authentik provider. The secret is write-only after saving. |
| Scopes                    | `openid profile email groups`                                       |

Click **Save OIDC settings**, then **Test sign-in** (it saves, loads the discovery document and checks the client secret).

Set **Sign-in method** to **Both** while you test, so password login stays available. Switch to **SSO only** once SSO works. If you lock yourself out, see [Security](/en/users/security) for `tokenhop auth reset-mode password`.

### 4. Set the group policy

Open **Admin → SSO provisioning** (needs users & teams on and the settings capability: owner or admin):

- **OIDC groups claim:** the claim path, default `groups`. Nested claims use dots, up to 5 levels.
- **Default role:** **Pending approval** (default) or **User**.
- **Allowed groups:** one group name per line. **Empty means every authenticated identity may sign in.** If set, a user must be in at least one of them.
- **Admin groups:** members become instance admins.
- **Workspace mapping:** group → shared workspace + role (Manager, Member or Viewer).

**Preview draft** tests the unsaved draft against your own identity. It shows the groups the IdP sent, the sign-in decision, admin match, new-account role and resulting workspace memberships. Nothing is saved and your account is not changed.

Group names are matched exactly (case-sensitive). At most 100 groups per login are read, each up to 256 characters. A scalar string counts as one group; tokenhop does not split comma-separated strings.

---

## How Groups Become Roles and Memberships

- **Allowed groups** gate sign-in. A user outside every allowed group sees "Your account is not in a group that may sign in here."
- **Admin groups:** a user in one of them who is `user` or `pending` becomes `admin`, marked as IdP-granted. If they later leave the group, that IdP-granted admin role drops back to `user`. Admins promoted by hand are not demoted by SSO, and the **owner** is never changed by SSO.
- **Workspace mapping:** each matching group adds the user to the target workspace. If several groups point at one workspace, the **highest** role wins (Manager > Member > Viewer). Only **shared** workspaces can be targets; a mapping to a deleted or personal workspace makes the login fail with "Could not finish setting up your account" until you fix the map.
- **Only IdP-sourced memberships are synced.** Memberships added by hand or by invitation are never touched. Removing a user from a group removes only the membership the IdP created.
- A change of role or memberships revokes the user's sessions (the session version is bumped), so they sign in again with the new access.

### Pending approval

With **Default role = Pending approval**, new SSO accounts land on **Waiting for approval** and cannot sign in or join anything. An admin opens **Admin → Users → the user** and clicks **Approve as user**. The user signs in again afterwards. A valid [invitation](/en/users/teams) approves the account directly as a `user`.

---

## Linking the Owner's SSO Account

The owner exists before SSO is configured (it comes from the password login). SSO identities are only linked to the owner through one of two explicit proofs, so a stranger who signs in first cannot take the owner account. Until the owner links, their SSO login creates a separate, pending account.

### Option 1: `TOKENHOP_OWNER_EMAIL`

Set the owner's email in the environment:

```bash
TOKENHOP_OWNER_EMAIL=owner@example.com
```

The first SSO login whose **verified** email matches (case-insensitive) is linked to the owner. This works **once**. The IdP must send `email` **and** `email_verified: true` in the id_token. Otherwise the login is provisioned as a separate pending user. For SAML, an email-shaped value from the configured email attribute (or `email`, `mail`, and similar) or an `emailAddress`-format NameID counts as verified.

### Option 2: setup token

When SSO is configured and neither `TOKENHOP_OWNER_EMAIL` nor an SSO link exists, tokenhop prints a single-use owner setup token to the server output at start. Mint a new one any time, from the host:

```bash
tokenhop auth setup-token [--port <port>]
```

The token is valid for 60 minutes and works once. Open one of these URLs on your instance and sign in with the owner's SSO account. Open the link in a private window and don't share it; the token is single-use and expires after 60 minutes.

```text
/api/auth/oidc/start?setupToken=<token>
/api/auth/saml/start?setupToken=<token>
```

Linking is permanent. The command is host-local and needs users & teams on.

---

## SSO Re-authentication for Backups

Instance and workspace exports and imports ask you to prove who you are again. Besides your password, you can use **Verify with single sign-on** in the backup dialogs (**Settings → Data & backup**). The button appears when your account has a linked OIDC or SAML identity (with both linked, choose the provider).

- It sends you to your IdP for a **fresh** sign-in. OIDC is asked to re-authenticate (`prompt=login`, `max_age=0`) and the id_token must carry `auth_time`; SAML requests `ForceAuthn`. A provider that omits `auth_time` cannot be used for this.
- You return to the same dialog with **Verified with single sign-on**. The proof is **one-time** and lasts **5 minutes**: good for one import or one download.
- It is bound to that exact action, your user, and (for workspace actions) the workspace. A failed or reused attempt spends it, and then only a fresh SSO check is accepted, not a password.
- **Import:** the page reloads at the IdP, so the dialog asks you to **choose the backup file again** after you come back.
- **Who:** a workspace backup needs the workspace **owner**. An instance backup needs an instance **owner or admin**. Forcing an instance restore that replaces differing users is owner-only.
- **The CLI cannot use SSO proofs.** They belong to browser sessions; the CLI token and local principals are refused. See [Security](/en/users/security) for the password route.

---

## Generic OIDC Reference

tokenhop uses the authorization-code flow with PKCE (`S256`) and a nonce, and posts the client secret to the token endpoint.

| Setting (Settings → Single sign-on)              | Key                | Default                |
| ------------------------------------------------ | ------------------ | ---------------------- |
| Sign-in method (Password only / SSO only / Both) | `authMode`         | `password`             |
| Protocol (OIDC / SAML 2.0)                       | `ssoType`          | `oidc`                 |
| Issuer URL                                       | `oidcIssuerUrl`    | empty                  |
| Client ID                                        | `oidcClientId`     | empty                  |
| Client secret (write-only)                       | `oidcClientSecret` | empty                  |
| Scopes                                           | `oidcScopes`       | `openid profile email` |
| Button label                                     | `oidcLoginLabel`   | `Sign in with OIDC`    |
| OIDC groups claim (Admin → SSO provisioning)     | `ssoGroupsClaim`   | `groups`               |

- **Redirect URI to register at the IdP:** `<public origin>/api/auth/oidc/callback`. The login starts at `/api/auth/oidc/start`.
- **Public origin:** set `BASE_URL` to the exact public scheme, host and port when tokenhop is behind a proxy. Otherwise tokenhop derives it from the request headers.
- **Discovery:** `<issuer>/.well-known/openid-configuration` must load. It must include the authorization, token and JWKS endpoints, plus UserInfo if you rely on the groups fallback.
- **Token checks:** the id_token's issuer, audience (the client ID) and nonce must match. `RS*`, `PS*`, `ES*` and `EdDSA` are verified against the JWKS; `HS*` against the client secret (see above).
- **Claims used:** `sub` (required, with `iss`), `email` and `email_verified` (owner linking and invitations), and `preferred_username`, `email` or `name` for the display name.
- **Callback errors** appear on the login page as short messages, for example `oidc_invalid_state` (the sign-in expired or started in another tab) and `sso_groups_unavailable`.

---

## SAML Reference

| Setting                                          | Key                   | Default                 |
| ------------------------------------------------ | --------------------- | ----------------------- |
| Single sign-on service URL                       | `samlEntryPoint`      | empty                   |
| SP entity ID / audience                          | `samlIssuer`          | `urn:tokenhop:sp`       |
| IdP X.509 certificate                            | `samlCert`            | empty                   |
| Login button label                               | `samlLoginLabel`      | `Sign in with SAML SSO` |
| Email claim attribute                            | `samlAttributeEmail`  | `email`                 |
| Display name claim                               | `samlAttributeName`   | `name`                  |
| SAML groups attribute (Admin → SSO provisioning) | `samlAttributeGroups` | `groups`                |

- **ACS (callback) URL:** `<public origin>/api/auth/saml/acs`. The login starts at `/api/auth/saml/start`.
- **SP metadata XML:** `<public origin>/api/auth/saml/metadata` (copy or **Download XML** on the settings page). The metadata is built from the origin you request it on, so open it through the public URL when tokenhop is behind a proxy.
- **Import:** **Upload metadata XML** fills the SSO URL and certificate from your IdP's metadata. **Test sign-in** checks the configuration.
- **Signatures:** both the response **and** the assertion must be signed with the certificate you pasted. Unsigned or partly signed responses are rejected. Clock skew allowed: 60 seconds.
- **NameID:** the NameID is the stable subject of the account. Use `EmailAddress` or `Unspecified`, and a value that does not change.
- **Groups:** send a multi-valued attribute named as in **SAML groups attribute** (exact key, URI-style names are kept literally). As with OIDC, the attribute must be present, an empty list is fine.
- **Changing the entity ID** on an existing install needs the same change at the IdP in one step (see [Upgrading](/en/upgrading)).

---

## Troubleshooting Sign-In

| Message on the login page                                | Meaning                                                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Your account is not in a group that may sign in here.    | **Allowed groups** is set and the user matches none.                                                        |
| Your sign-in provider did not send group information.    | The groups claim or attribute is missing. Check the scope mapping, the **Scopes** field and the claim name. |
| This single sign-on account isn't linked to a user here. | An unlinked identity could not be provisioned. Link the owner first, or ask an admin.                       |
| This account is waiting for an admin to approve it.      | Pending approval.                                                                                           |
| Could not finish setting up your account.                | A workspace mapping points at a missing or personal workspace.                                              |

---

## Next Steps

- [Concepts](/en/users/concepts): instance roles, workspaces and memberships
- [Teams](/en/users/teams): invitations, members and workspace administration
- [Security](/en/users/security): encryption, backups and locked-out recovery
