// YAN-360: ownership transfer for SSO-only owners. Starts a forced, fresh IdP
// login (OIDC prompt=login + max_age=0, SAML ForceAuthn) bound to an encrypted
// owner_transfer_state cookie. The IdP callback completes the swap through
// completeSsoOwnershipTransfer and never mints a session. Hidden (404) while
// the multi-user switch is off; full browser session of the live owner only.
import { cookies } from "next/headers";
import {
  buildOidcAuthorizationUrl,
  createOidcNonce,
  createOidcState,
  createPkcePair,
  fetchOidcDiscovery,
  getOidcRuntimeConfig,
  getPublicOrigin,
} from "@/lib/auth/oidc";
import { buildSamlReauthAuthorizeUrl, isSamlConfigured } from "@/lib/auth/saml.js";
import { resolveAuthModes } from "@/lib/auth/authModes";
import { getDashboardAuthSession, shouldUseSecureCookie } from "@/lib/auth/dashboardSession.js";
import {
  OWNER_TRANSFER_COOKIE,
  ownerTransferCookieOptions,
  sealOwnerTransferState,
} from "@/lib/auth/ownershipTransferState.js";
import {
  accountKey,
  checkLoginLocks,
  getClientIp,
  recordLoginFail,
} from "@/lib/auth/loginLimiter.js";
import { getSettings } from "@/lib/localDb";
import { listIdentitiesUnscoped } from "@/lib/db/repos/identitiesRepo.js";
import { getUserUnscoped } from "@/lib/db/repos/usersRepo.js";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import {
  json,
  payloadTooLarge,
  PayloadTooLarge,
  readJsonBody,
  requireManagedSession,
} from "@/lib/users/userManagement.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid = () => json({ error: "Invalid request", code: "invalid_request" }, 400);
const forbidden = () =>
  json({ error: "Only the instance owner can transfer ownership", code: "forbidden" }, 403);
const badTarget = () => json({ error: "Invalid transfer target", code: "invalid_target" }, 409);
const unavailable = () =>
  json(
    { error: "No linked single sign-on identity for this provider", code: "reauth_unavailable" },
    409,
  );

// Exactly one linked identity of the provider (and issuer, when known), else null.
function pickIdentity(identities, provider, issuer) {
  const hits = identities.filter(
    (i) => i.provider === provider && i.subject && i.issuer && (!issuer || i.issuer === issuer),
  );
  return hits.length === 1 ? hits[0] : null;
}

async function oidcFlow(request, identities) {
  const config = await getOidcRuntimeConfig();
  if (!config) return { res: unavailable() };
  const discovery = await fetchOidcDiscovery(config.issuerUrl);
  const identity = pickIdentity(identities, "oidc", discovery.issuer || config.issuerUrl);
  if (!identity) return { res: unavailable() };
  const state = createOidcState();
  const nonce = createOidcNonce();
  const { verifier, challenge } = createPkcePair();
  const url = new URL(
    buildOidcAuthorizationUrl({
      authorizationEndpoint: discovery.authorization_endpoint,
      clientId: config.clientId,
      redirectUri: `${getPublicOrigin(request)}/api/auth/oidc/callback`,
      scopes: config.scopes,
      state,
      nonce,
      codeChallenge: challenge,
    }),
  );
  // Force a fresh IdP login; max_age also makes the IdP return auth_time.
  url.searchParams.set("prompt", "login");
  url.searchParams.set("max_age", "0");
  return { identity, authorizeUrl: url.toString(), extra: { state, nonce, verifier } };
}

async function samlFlow(request, identities) {
  const settings = await getSettings();
  if (!resolveAuthModes(settings).saml || !isSamlConfigured(settings))
    return { res: unavailable() };
  const identity = pickIdentity(identities, "saml", null);
  if (!identity) return { res: unavailable() };
  const { authorizeUrl, requestId } = await buildSamlReauthAuthorizeUrl(request, settings);
  return { identity, authorizeUrl, extra: { requestId } };
}

export async function POST(request) {
  try {
    const hidden = await requireMultiUser();
    if (hidden) return hidden;
    const gate = await requireManagedSession(request, {
      capability: "instance.ownership.transfer",
      body: true,
    });
    if (gate.res) return gate.res;
    const { principal } = gate;

    let body;
    try {
      body = await readJsonBody(request, { max: 1024 });
    } catch (err) {
      if (err instanceof PayloadTooLarge) return payloadTooLarge();
      throw err;
    }
    const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
    if (
      keys.length !== 2 ||
      typeof body.toUserId !== "string" ||
      !UUID_RE.test(body.toUserId) ||
      !["oidc", "saml"].includes(body.provider)
    ) {
      return invalid();
    }

    // SAML's cross-site POST return needs a SameSite=None cookie, which browsers
    // only keep when Secure: refuse now rather than after the IdP round trip.
    const secure = shouldUseSecureCookie(request);
    if (body.provider === "saml" && !secure) return unavailable();

    const ip = getClientIp(request);
    const account = accountKey({ userId: principal.userId });
    const lock = checkLoginLocks({ ip, account });
    if (lock.locked) {
      return json(
        { error: "Too many attempts", code: "rate_limited", retryAfter: lock.retryAfter },
        429,
      );
    }

    // The proof binds to this exact session version; the swap re-checks it.
    const cookieStore = await cookies();
    const claims = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
    const owner = await getUserUnscoped(principal.userId);
    if (
      !owner ||
      owner.instanceRole !== "owner" ||
      owner.status !== "active" ||
      claims?.sub !== owner.id ||
      claims.sv !== owner.sessionVersion
    ) {
      recordLoginFail({ ip, account });
      return forbidden();
    }
    const target = await getUserUnscoped(body.toUserId);
    if (!target || target.id === owner.id || target.status !== "active") {
      recordLoginFail({ ip, account });
      return badTarget();
    }

    const identities = await listIdentitiesUnscoped(owner.id);
    const flow =
      body.provider === "oidc"
        ? await oidcFlow(request, identities)
        : await samlFlow(request, identities);
    if (flow.res) return flow.res;

    const sealed = await sealOwnerTransferState({
      ownerId: owner.id,
      sessionVersion: owner.sessionVersion,
      toUserId: target.id,
      provider: body.provider,
      issuer: flow.identity.issuer,
      subject: flow.identity.subject,
      ...flow.extra,
    });
    const options = ownerTransferCookieOptions(secure);
    // SAML returns through a cross-site POST: Lax cookies are not sent there.
    if (body.provider === "saml") {
      options.sameSite = "none";
      // A leftover normal-login request ID would make the ACS skip the transfer.
      cookieStore.delete("saml_state");
    }
    cookieStore.set(OWNER_TRANSFER_COOKIE, sealed, options);
    const res = json({ authorizeUrl: flow.authorizeUrl });
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  } catch (err) {
    console.warn("[ownership-transfer] SSO start failed:", err?.code || "error");
    return json({ error: "Internal error" }, 500);
  }
}
