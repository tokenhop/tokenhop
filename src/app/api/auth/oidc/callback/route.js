import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  exchangeOidcCode,
  fetchOidcDiscovery,
  fetchOidcUserInfo,
  getOidcRuntimeConfig,
  getPublicOrigin,
  OIDC_COOKIE_NAMES,
  openInviteState,
  pickOidcDisplayName,
  pickOidcEmail,
  verifyOidcIdToken,
} from "@/lib/auth/oidc";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import {
  OWNER_TRANSFER_COOKIE,
  openOwnerTransferState,
} from "@/lib/auth/ownershipTransferState.js";
import { completeSsoOwnershipTransfer } from "@/lib/users/ssoOwnershipTransfer.js";
import { isMultiUserEnabled } from "@/lib/users/featureSwitch.js";
import { audit } from "@/lib/users/audit";
import { sessionClaims } from "@/lib/users/session";
import { SETUP_TOKEN_COOKIE, takeSetupToken } from "@/lib/users/bootstrap";
import { getSettings } from "@/lib/db/index.js";
import { isUserSecurityEnforced } from "@/lib/users/securityState";
import { readGroupsClaim, ssoAdmit, SsoAdmissionError } from "@/lib/users/ssoProvisioning";
import {
  accountKey,
  checkLoginLocks,
  recordLoginFail,
  clearAccount,
  getClientIp,
} from "@/lib/auth/loginLimiter";

const ADMISSION_ERRORS = {
  denied: "sso_group_denied",
  groups_unavailable: "sso_groups_unavailable",
  disabled: "account_disabled",
  sync_failed: "sso_sync_failed",
};

function clearOidcCookies(cookieStore) {
  for (const name of Object.values(OIDC_COOKIE_NAMES)) cookieStore.delete(name);
}

// YAN-360: owner re-auth for ownership transfer. Runs before any login logic
// and never mints a session or admits a user; any defect fails closed.
// Only a cookie that opens, is OIDC, and matches this callback's `state` claims
// the request; anything else (stale, tampered, abandoned) is dropped so an
// unrelated normal login proceeds untouched.
async function claimOwnerTransfer(request, cookieStore) {
  const sealed = cookieStore.get(OWNER_TRANSFER_COOKIE)?.value;
  if (sealed === undefined) return null;
  cookieStore.delete(OWNER_TRANSFER_COOKIE);
  const st = await openOwnerTransferState(sealed);
  const state = new URL(request.url).searchParams.get("state");
  if (!st || st.provider !== "oidc" || !st.state || !state || state !== st.state) return null;
  return st;
}

async function completeOwnerTransfer(request, cookieStore, st) {
  const origin = getPublicOrigin(request);
  const ip = getClientIp(request);
  const account = accountKey({ userId: st.ownerId });
  try {
    if (!(await isMultiUserEnabled())) throw new Error("multi_user_disabled");
    if (checkLoginLocks({ ip, account }).locked) throw new Error("locked");
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    if (!st.nonce || !st.verifier || !code || url.searchParams.get("error")) {
      throw new Error("invalid_transfer_callback");
    }
    const config = await getOidcRuntimeConfig();
    if (!config) throw new Error("oidc_not_configured");
    const discovery = await fetchOidcDiscovery(config.issuerUrl);
    const tokenData = await exchangeOidcCode({
      tokenEndpoint: discovery.token_endpoint,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri: `${origin}/api/auth/oidc/callback`,
      codeVerifier: st.verifier,
    });
    if (!tokenData.id_token) throw new Error("missing_id_token");
    const payload = await verifyOidcIdToken({
      idToken: tokenData.id_token,
      issuer: discovery.issuer || config.issuerUrl,
      audience: config.clientId,
      jwksUri: discovery.jwks_uri,
      nonce: st.nonce,
      clientSecret: config.clientSecret,
      allowedAlgs: discovery.id_token_signing_alg_values_supported,
    });
    // auth_time is mandatory: without it the IdP may have reused an old session.
    if (!Number.isInteger(payload.auth_time)) throw new Error("missing_auth_time");
    // The repo audits the successful swap.
    await completeSsoOwnershipTransfer({
      state: st,
      provider: "oidc",
      issuer: payload.iss,
      subject: payload.sub,
      authenticatedAtMs: payload.auth_time * 1000,
    });
  } catch (err) {
    recordLoginFail({ ip, account });
    console.warn("[OIDC] ownership re-auth failed:", err?.code || "error");
    return NextResponse.redirect(new URL("/login?error=ownership_reauth_failed", origin));
  }
  clearAccount(account);
  // Both owners' sessions were revoked by the sessionVersion bump.
  cookieStore.delete("auth_token");
  return NextResponse.redirect(new URL("/login?transferred=1", origin));
}

export async function GET(request) {
  const transferStore = await cookies();
  const transfer = await claimOwnerTransfer(request, transferStore);
  if (transfer) return completeOwnerTransfer(request, transferStore, transfer);
  let enforced;
  try {
    enforced = await isUserSecurityEnforced();
  } catch {
    console.warn("[OIDC] callback failed: security_state_unavailable");
    clearOidcCookies(await cookies());
    return NextResponse.redirect(
      new URL("/login?error=oidc_callback_failed", getPublicOrigin(request)),
    );
  }
  const ip = enforced ? getClientIp(request) : null;
  let account;
  const fail = (code) => {
    recordLoginFail({ ip, account });
    console.warn("[OIDC] callback denied:", code);
    audit(
      { request },
      "auth.loginFailed",
      { type: "user" },
      { after: { provider: "oidc", reason: code }, result: "failure" },
    );
    return NextResponse.redirect(new URL(`/login?error=${code}`, getPublicOrigin(request)));
  };
  if (enforced && checkLoginLocks({ ip }).locked) {
    clearOidcCookies(await cookies());
    return NextResponse.redirect(
      new URL("/login?error=too_many_attempts", getPublicOrigin(request)),
    );
  }
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const earlyExit = async () => clearOidcCookies(await cookies());
  if (error) {
    await earlyExit();
    if (enforced) return fail("oidc_callback_failed");
    console.warn("[OIDC] provider returned error:", error);
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error)}`, getPublicOrigin(request)),
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    await earlyExit();
    if (enforced) return fail("oidc_missing_code");
    return NextResponse.redirect(
      new URL("/login?error=oidc_missing_code", getPublicOrigin(request)),
    );
  }

  const cookieStore = await cookies();
  const storedState = cookieStore.get("oidc_state")?.value;
  const storedNonce = cookieStore.get("oidc_nonce")?.value;
  const codeVerifier = cookieStore.get("oidc_code_verifier")?.value;
  // Captured before the cookies are cleared; opened only after id_token verification.
  const sealedInvite = cookieStore.get(OIDC_COOKIE_NAMES.invite)?.value;

  if (!storedState || !storedNonce || !codeVerifier || storedState !== state) {
    clearOidcCookies(cookieStore);
    if (enforced) return fail("oidc_invalid_state");
    return NextResponse.redirect(
      new URL("/login?error=oidc_invalid_state", getPublicOrigin(request)),
    );
  }

  try {
    const config = await getOidcRuntimeConfig();
    if (!config) {
      clearOidcCookies(cookieStore);
      if (enforced) return fail("oidc_not_configured");
      return NextResponse.redirect(
        new URL("/login?error=oidc_not_configured", getPublicOrigin(request)),
      );
    }

    const discovery = await fetchOidcDiscovery(config.issuerUrl);
    const discoveredIssuer = discovery.issuer || config.issuerUrl;
    const redirectUri = `${getPublicOrigin(request)}/api/auth/oidc/callback`;
    const tokenData = await exchangeOidcCode({
      tokenEndpoint: discovery.token_endpoint,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri,
      codeVerifier,
    });

    if (!tokenData.id_token) {
      throw new Error("OIDC provider did not return an id_token");
    }

    const payload = await verifyOidcIdToken({
      idToken: tokenData.id_token,
      issuer: discoveredIssuer,
      audience: config.clientId,
      jwksUri: discovery.jwks_uri,
      nonce: storedNonce,
      clientSecret: config.clientSecret,
      allowedAlgs: discovery.id_token_signing_alg_values_supported,
    });

    clearOidcCookies(cookieStore);
    // YAN-360: a present invite proof must open for exactly this flow's state,
    // else fail closed (never a silent ordinary login). Not logged.
    let invitationToken;
    if (sealedInvite) {
      invitationToken = (await openInviteState(sealedInvite, storedState)) || undefined;
      // Invites need admission (enforced security); never degrade to a plain login.
      if (!invitationToken || !enforced) throw new SsoAdmissionError("denied");
    }
    const identity = {
      provider: "oidc",
      issuer: payload.iss || discoveredIssuer,
      subject: payload.sub,
      email: pickOidcEmail(payload),
      emailVerified: payload.email_verified === true,
    };
    let opts;
    if (enforced) {
      if (
        typeof identity.issuer !== "string" ||
        !identity.issuer ||
        typeof identity.subject !== "string" ||
        !identity.subject
      )
        throw new SsoAdmissionError("denied");
      account = `sso:${JSON.stringify([identity.provider, identity.issuer, identity.subject])}`;
      if (checkLoginLocks({ ip, account }).locked) {
        return NextResponse.redirect(
          new URL("/login?error=too_many_attempts", getPublicOrigin(request)),
        );
      }
      const settings = await getSettings();
      const claimPath = settings.ssoGroupsClaim || "groups";
      let source = readGroupsClaim(payload, claimPath);
      if (!source.present && !source.invalid) {
        try {
          const userInfo = await fetchOidcUserInfo({
            userinfoEndpoint: discovery.userinfo_endpoint,
            accessToken: tokenData.access_token,
            expectedSub: identity.subject,
            expectedIssuer: identity.issuer,
          });
          source = readGroupsClaim(userInfo, claimPath);
        } catch {
          throw new SsoAdmissionError("groups_unavailable");
        }
      }
      if (!source.present || source.invalid || !Array.isArray(source.groups)) {
        throw new SsoAdmissionError("groups_unavailable");
      }
      const admitted = await ssoAdmit(
        { ...identity, displayName: pickOidcDisplayName(payload) },
        source.groups,
        {
          setupToken: cookieStore.get(SETUP_TOKEN_COOKIE)?.value,
          ...(invitationToken ? { invitationToken } : {}),
        },
      );
      takeSetupToken(cookieStore);
      if (admitted.kind === "pending") {
        clearAccount(account);
        audit(
          { request },
          "auth.loginPending",
          { type: "user", id: admitted.userId },
          { after: { provider: "oidc", reason: "pending" }, result: "pending" },
        );
        return NextResponse.redirect(new URL("/login/pending", getPublicOrigin(request)));
      }
      opts = { admittedUserId: admitted.userId };
    } else {
      opts = { setupToken: takeSetupToken(cookieStore) };
    }
    const claims = await sessionClaims("oidc", identity, opts);
    if (!claims) {
      if (enforced) return fail("sso_sync_failed");
      audit(
        { request },
        "auth.loginFailed",
        { type: "user" },
        { after: { provider: "oidc", reason: "notLinked" }, result: "failure" },
      );
      return NextResponse.redirect(
        new URL("/login?error=sso_not_linked", getPublicOrigin(request)),
      );
    }
    await setDashboardAuthCookie(cookieStore, request, {
      ...claims,
      oidc: true,
      oidcSub: payload.sub || null,
      oidcEmail: pickOidcEmail(payload) || null,
      oidcName: pickOidcDisplayName(payload),
    });
    if (enforced) clearAccount(account);
    audit(
      { principal: claims.sub ? { userId: claims.sub, via: "session" } : null, request },
      "auth.login",
      { type: "user", id: claims.sub ?? null },
      { after: { provider: "oidc" } },
    );

    return NextResponse.redirect(new URL("/dashboard", getPublicOrigin(request)));
  } catch (error) {
    if (enforced) {
      clearOidcCookies(cookieStore);
      return fail(
        error instanceof SsoAdmissionError
          ? ADMISSION_ERRORS[error.code] || "sso_sync_failed"
          : "oidc_callback_failed",
      );
    }
    console.warn("[OIDC] callback failed:", error?.message || error);
    audit(
      { request },
      "auth.loginFailed",
      { type: "user" },
      { after: { provider: "oidc", reason: "error" }, result: "failure" },
    );
    clearOidcCookies(cookieStore);
    return NextResponse.redirect(
      new URL("/login?error=oidc_callback_failed", getPublicOrigin(request)),
    );
  }
}
