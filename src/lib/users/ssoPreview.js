// Fresh IdP round trips, never admission: no provisioning, linking, sync or session mint.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  buildOidcAuthorizationUrl,
  createOidcNonce,
  createPkcePair,
  fetchOidcDiscovery,
  getOidcRuntimeConfig,
  getPublicOrigin,
  exchangeOidcCode,
  verifyOidcIdToken,
  fetchOidcUserInfo,
} from "@/lib/auth/oidc.js";
import {
  buildSamlReauthAuthorizeUrl,
  isSamlConfigured,
  getSamlBaseUrl,
  validateSamlResponse,
  verifyFreshSamlAuthnInstant,
  pickSamlGroups,
} from "@/lib/auth/saml.js";
import { resolveAuthModes } from "@/lib/auth/authModes.js";
import { shouldUseSecureCookie, getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import {
  accountKey,
  checkLoginLocks,
  getClientIp,
  recordLoginFail,
  clearAccount,
} from "@/lib/auth/loginLimiter.js";
import { getAdapter } from "@/lib/db/driver.js";
import { getSettings, SSO_POLICY_KEYS } from "@/lib/db/repos/settingsRepo.js";
import { listIdentitiesUnscoped } from "@/lib/db/repos/identitiesRepo.js";
import {
  validateSsoPolicy,
  validateSsoWorkspaceTargets,
} from "@/app/api/settings/validateSettings.js";
import { readGroupsClaim, resolveAssignments } from "./ssoProvisioning.js";
import { isMultiUserEnabled } from "./featureSwitch.js";
import { TenancyError } from "./errors.js";
import { json, PayloadTooLarge, readBoundedBody } from "./userManagement.js";
import {
  SSO_PROOF_COOKIE,
  SSO_PREVIEW_PURPOSE,
  WORKSPACE_DELETE_PURPOSE,
  PROOF_FLOW_PREFIX,
  putProofSlot,
  peekProofSlot,
  takeProofSlot,
  sealSsoProofState,
  openSsoProofState,
  assertSlotBinding,
  assertFreshIdentity,
} from "./ssoProofState.js";
import { randomBytes } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function proofJson(body, status = 200) {
  const res = json(body, status);
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

export function proofFailure(err) {
  if (err instanceof PayloadTooLarge)
    return proofJson({ error: "Payload too large", code: "payload_too_large" }, 413);
  const codes = {
    INVALID: [400, "invalid_request"],
    NOT_FOUND: [404, "not_found"],
    FORBIDDEN: [403, "forbidden"],
    STALE: [409, "stale_session"],
    SSO_NOT_LINKED: [409, "sso_not_linked"],
    SSO_UNAVAILABLE: [409, "sso_unavailable"],
    REAUTH_REQUIRED: [401, "reauth_required"],
    PROOF_CAPACITY: [503, "service_unavailable"],
  };
  const [status, code] = codes[err?.code] ?? [500, "internal_error"];
  return proofJson({ error: "SSO proof unavailable", code }, status);
}

export async function proofSessionVersion(principal, jar = null) {
  const store = jar ?? (await cookies());
  const claims = await getDashboardAuthSession(store.get("auth_token")?.value);
  if (claims?.sub !== principal.userId || !Number.isInteger(claims.sv)) {
    throw new TenancyError("STALE", "Session is out of date");
  }
  return claims.sv;
}

// Sync live authority read; final deletion uses its own transaction read.
export function assertProofActor(db, actorId, sv) {
  const actor = db.get("SELECT status, instanceRole, sessionVersion FROM users WHERE id = ?", [
    actorId,
  ]);
  if (actor?.status !== "active" || !["owner", "admin"].includes(actor.instanceRole)) {
    throw new TenancyError("FORBIDDEN", "Forbidden");
  }
  if (!Number.isInteger(sv) || actor.sessionVersion !== sv)
    throw new TenancyError("STALE", "Session is out of date");
}

export function proofLock(request, userId) {
  const lock = checkLoginLocks({ ip: getClientIp(request), account: accountKey({ userId }) });
  if (!lock.locked) return null;
  const res = proofJson(
    { error: "Too many attempts", code: "rate_limited", retryAfter: lock.retryAfter },
    429,
  );
  res.headers.set("Retry-After", String(lock.retryAfter));
  return res;
}

export async function beginSsoProof(request, principal, { provider, policy, workspaceId = null }) {
  const jar = await cookies();
  const sv = await proofSessionVersion(principal, jar);
  const db = await getAdapter();
  assertProofActor(db, principal.userId, sv);
  const purpose = workspaceId ? WORKSPACE_DELETE_PURPOSE : SSO_PREVIEW_PURPOSE;
  // Deletion re-auth carries no policy: a broken saved SSO map must never block
  // it (the delete transaction itself cleans that map).
  let draft = null;
  if (purpose === SSO_PREVIEW_PURPOSE) {
    const settings = await getSettings({ secretMode: "metadata" });
    draft = Object.fromEntries(SSO_POLICY_KEYS.map((k) => [k, settings[k]]));
    if (policy !== undefined) {
      if (
        !policy ||
        typeof policy !== "object" ||
        Array.isArray(policy) ||
        Object.keys(policy).some((k) => !SSO_POLICY_KEYS.includes(k))
      )
        throw new TenancyError("INVALID", "Invalid policy");
      Object.assign(draft, policy);
    }
    if (
      validateSsoPolicy(draft) ||
      (await validateSsoWorkspaceTargets(draft.ssoGroupWorkspaceMap))
    ) {
      throw new TenancyError("INVALID", "Invalid policy");
    }
  } else if (policy !== undefined) {
    throw new TenancyError("INVALID", "Invalid policy");
  }
  const secure = shouldUseSecureCookie(request);
  if (provider === "saml" && !secure)
    throw new TenancyError("SSO_UNAVAILABLE", "Secure cookie required");
  const identities = await listIdentitiesUnscoped(principal.userId);
  const flow = PROOF_FLOW_PREFIX + randomBytes(32).toString("base64url");
  let issuer, authorizeUrl, extra;
  if (provider === "oidc") {
    const config = await getOidcRuntimeConfig();
    if (!config) throw new TenancyError("SSO_UNAVAILABLE", "SSO unavailable");
    const discovery = await fetchOidcDiscovery(config.issuerUrl);
    issuer = discovery.issuer || config.issuerUrl;
    const nonce = createOidcNonce();
    const { verifier, challenge } = createPkcePair();
    const url = new URL(
      buildOidcAuthorizationUrl({
        authorizationEndpoint: discovery.authorization_endpoint,
        clientId: config.clientId,
        redirectUri: `${getPublicOrigin(request)}/api/auth/oidc/callback`,
        scopes: config.scopes,
        state: flow,
        nonce,
        codeChallenge: challenge,
      }),
    );
    url.searchParams.set("prompt", "login");
    url.searchParams.set("max_age", "0");
    authorizeUrl = url.toString();
    extra = { nonce, verifier };
  } else if (provider === "saml") {
    const saved = await getSettings();
    if (!resolveAuthModes(saved).saml || !isSamlConfigured(saved))
      throw new TenancyError("SSO_UNAVAILABLE", "SSO unavailable");
    const built = await buildSamlReauthAuthorizeUrl(request, saved);
    const url = new URL(built.authorizeUrl);
    url.searchParams.set("RelayState", flow);
    authorizeUrl = url.toString();
    extra = { requestId: built.requestId };
  } else throw new TenancyError("INVALID", "Invalid provider");
  const hits = identities.filter(
    (i) => i.provider === provider && i.issuer && i.subject && (!issuer || i.issuer === issuer),
  );
  if (hits.length !== 1) throw new TenancyError("SSO_NOT_LINKED", "SSO not linked");
  const state = { purpose, actorId: principal.userId, sv, provider, flow };
  const ref = putProofSlot({
    ...state,
    workspaceId,
    issuer: hits[0].issuer,
    subject: hits[0].subject,
    startedAt: Date.now(),
    stage: "draft",
    secure,
    policy: draft,
    ...extra,
  });
  try {
    jar.set(SSO_PROOF_COOKIE, await sealSsoProofState({ ...state, ref }), {
      httpOnly: true,
      secure,
      sameSite: provider === "saml" ? "none" : "lax",
      path: "/",
      maxAge: 300,
    });
  } catch (err) {
    takeProofSlot(ref);
    throw err;
  }
  return proofJson({ authorizeUrl });
}

async function oidcClaims(request, slot) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.get("error")) throw new Error("invalid_callback");
  const config = await getOidcRuntimeConfig();
  if (!config) throw new Error("sso_unavailable");
  const discovery = await fetchOidcDiscovery(config.issuerUrl);
  const tokens = await exchangeOidcCode({
    tokenEndpoint: discovery.token_endpoint,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    code,
    redirectUri: `${getPublicOrigin(request)}/api/auth/oidc/callback`,
    codeVerifier: slot.verifier,
  });
  if (!tokens.id_token) throw new Error("invalid_callback");
  const p = await verifyOidcIdToken({
    idToken: tokens.id_token,
    issuer: discovery.issuer || config.issuerUrl,
    audience: config.clientId,
    jwksUri: discovery.jwks_uri,
    nonce: slot.nonce,
    clientSecret: config.clientSecret,
    allowedAlgs: discovery.id_token_signing_alg_values_supported,
  });
  if (!Number.isInteger(p.auth_time)) throw new Error("invalid_callback");
  assertFreshIdentity(slot, {
    issuer: p.iss,
    subject: p.sub,
    authenticatedAtMs: p.auth_time * 1000,
  });
  if (slot.purpose !== SSO_PREVIEW_PURPOSE) return {};
  let source = readGroupsClaim(p, slot.policy.ssoGroupsClaim || "groups");
  let groupsSource = "id_token";
  if (!source.present && !source.invalid) {
    const info = await fetchOidcUserInfo({
      userinfoEndpoint: discovery.userinfo_endpoint,
      accessToken: tokens.access_token,
      expectedSub: p.sub,
      expectedIssuer: p.iss,
    });
    // Keep this check even if protocol helper is replaced: no mismatched claims.
    if (info.sub !== p.sub || (Object.hasOwn(info, "iss") && info.iss !== p.iss))
      throw new Error("invalid_userinfo");
    source = readGroupsClaim(info, slot.policy.ssoGroupsClaim || "groups");
    groupsSource = "userinfo";
  }
  if (!source.present || source.invalid || !Array.isArray(source.groups))
    throw new Error("groups_unavailable");
  return { groups: source.groups, groupsSource };
}

// OIDC reserved state / SAML reserved RelayState explicitly identifies proof
// callbacks even when cookie is absent, expired or tampered: never fall back
// to admission. Nonmatching normal flows remain untouched.
export async function handleSsoProofCallback(request, provider, jar, settings = null) {
  let flow, form;
  if (provider === "oidc") flow = new URL(request.url).searchParams.get("state");
  else {
    // Clone keeps normal login/owner-transfer body untouched. Bound even when
    // malicious content-length lies; SAML POST binding uses RelayState.
    try {
      form = new URLSearchParams(await readBoundedBody(request.clone().body, 1024 * 1024));
    } catch {
      return null; // oversize: normal flow keeps its own handling
    }
    flow = form.get("RelayState");
  }
  if (!flow?.startsWith(PROOF_FLOW_PREFIX)) return null;
  const origin = provider === "oidc" ? getPublicOrigin(request) : getSamlBaseUrl(request, settings);
  const redirect = (path) => {
    const res = NextResponse.redirect(new URL(path, origin), 303);
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  };
  const state = await openSsoProofState(jar.get(SSO_PROOF_COOKIE)?.value);
  jar.delete(SSO_PROOF_COOKIE);
  let slot;
  try {
    if (!state || state.provider !== provider || state.flow !== flow)
      throw new Error("invalid_proof");
    slot = takeProofSlot(state.ref);
    assertSlotBinding(slot, state, "draft");
    if (!(await isMultiUserEnabled())) throw new Error("multi_user_disabled");
    if (proofLock(request, state.actorId)) throw new Error("rate_limited");
    const db = await getAdapter();
    assertProofActor(db, state.actorId, state.sv);
    let source;
    if (provider === "oidc") source = await oidcClaims(request, slot);
    else {
      if (!resolveAuthModes(settings).saml || !isSamlConfigured(settings))
        throw new Error("sso_unavailable");
      const response = form.get("SAMLResponse");
      if (!response) throw new Error("invalid_callback");
      const profile = await validateSamlResponse(
        request,
        { SAMLResponse: response },
        slot.requestId,
        settings,
      );
      const { authnInstant } = verifyFreshSamlAuthnInstant(profile, { startedAt: slot.startedAt });
      if (profile.nameIDFormat === "urn:oasis:names:tc:SAML:2.0:nameid-format:transient")
        throw new Error("invalid_identity");
      assertFreshIdentity(slot, {
        issuer: profile.issuer,
        subject: profile.nameID,
        authenticatedAtMs: authnInstant,
      });
      if (slot.purpose === SSO_PREVIEW_PURPOSE) {
        const picked = pickSamlGroups(profile, slot.policy);
        if (!picked.present || picked.invalid || !Array.isArray(picked.groups))
          throw new Error("groups_unavailable");
        source = { groups: picked.groups, groupsSource: "saml_attribute" };
      }
    }
    // Re-read after network/verification, including exact identity link. No writes.
    assertProofActor(db, state.actorId, state.sv);
    const identity = db.get(
      "SELECT userId FROM identities WHERE provider = ? AND issuer = ? AND subject = ?",
      [provider, slot.issuer, slot.subject],
    );
    if (identity?.userId !== state.actorId) throw new Error("invalid_identity");
    let result = null;
    if (slot.purpose === SSO_PREVIEW_PURPOSE) {
      if (await validateSsoWorkspaceTargets(slot.policy.ssoGroupWorkspaceMap))
        throw new Error("invalid_policy");
      const assignment = resolveAssignments(source.groups, slot.policy);
      result = {
        provider,
        groupsSource: source.groupsSource,
        groups: source.groups.slice(0, 20),
        totalGroups: source.groups.length,
        ...assignment,
        wouldProvisionRole: assignment.adminMatch ? "admin" : slot.policy.ssoDefaultRole,
        evaluatedAt: new Date().toISOString(),
      };
    }
    const ref = putProofSlot({ ...slot, stage: "result", result });
    jar.set(SSO_PROOF_COOKIE, await sealSsoProofState({ ...state, ref }), {
      httpOnly: true,
      // Begin-time decision: the ACS hop may see different forwarding headers.
      secure: slot.secure === true,
      sameSite: "lax",
      path: "/",
      maxAge: 300,
    });
    clearAccount(accountKey({ userId: state.actorId }));
    return redirect(
      slot.purpose === SSO_PREVIEW_PURPOSE
        ? "/dashboard/admin/sso?ssoPreview=1"
        : `/dashboard/admin/workspaces/${slot.workspaceId}?ssoReauth=1`,
    );
  } catch {
    recordLoginFail({
      ip: getClientIp(request),
      account: state ? accountKey({ userId: state.actorId }) : undefined,
    });
    // Fixed string only: no provider errors, tokens, claims or group names.
    console.warn("[SSO] fresh proof failed");
    // The admin is still logged in: return to the originating surface. Ids come
    // from the server-side slot only, never the request; unknown slot -> fixed path.
    return redirect(
      slot?.purpose === WORKSPACE_DELETE_PURPOSE && UUID_RE.test(slot.workspaceId ?? "")
        ? `/dashboard/admin/workspaces/${slot.workspaceId}?ssoReauth=failed`
        : "/dashboard/admin/sso?ssoPreview=failed",
    );
  }
}

export async function consumeSsoResult(principal, purpose, workspaceId = null) {
  const jar = await cookies();
  const state = await openSsoProofState(jar.get(SSO_PROOF_COOKIE)?.value);
  if (!state || state.purpose !== purpose || state.actorId !== principal.userId) return null;
  const sv = await proofSessionVersion(principal, jar);
  if (sv !== state.sv) throw new TenancyError("STALE", "Session is out of date");
  const db = await getAdapter();
  // No await from peek to take: concurrent GETs cannot both pass this block, so
  // exactly one mints a delete proof. A failed actor recheck below has already
  // consumed the slot (fail closed).
  const slot = peekProofSlot(state.ref);
  if (!slot) return null;
  assertSlotBinding(slot, state, "result");
  if (slot.workspaceId !== workspaceId) return null;
  takeProofSlot(state.ref);
  jar.delete(SSO_PROOF_COOKIE);
  assertProofActor(db, principal.userId, sv);
  if (purpose === SSO_PREVIEW_PURPOSE) return slot.result;
  const ssoProof = putProofSlot({ ...slot, stage: "delete_proof" });
  return { ssoProof };
}

export function consumeWorkspaceDeleteProof(ssoProof, actorId, workspaceId, sv) {
  const slot = takeProofSlot(ssoProof);
  if (
    slot?.stage !== "delete_proof" ||
    slot.purpose !== WORKSPACE_DELETE_PURPOSE ||
    slot.actorId !== actorId ||
    slot.workspaceId !== workspaceId ||
    slot.sv !== sv
  )
    throw new TenancyError("REAUTH_REQUIRED", "Fresh authentication required");
  return slot;
}
