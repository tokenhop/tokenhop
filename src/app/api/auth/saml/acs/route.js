import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import {
  getSamlBaseUrl,
  isSamlConfigured,
  openSamlInvite,
  pickSamlDisplayName,
  pickSamlEmail,
  pickVerifiedSamlEmail,
  pickSamlGroups,
  SAML_INVITE_COOKIE,
  validateSamlResponse,
  verifyFreshSamlAuthnInstant,
} from "@/lib/auth/saml.js";
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
import { isUserSecurityEnforced } from "@/lib/users/securityState";
import { ssoAdmit, SsoAdmissionError } from "@/lib/users/ssoProvisioning";

import { resolveAuthModes } from "@/lib/auth/authModes";
import {
  checkLock,
  recordFail,
  recordSuccess,
  getClientIp,
  checkLoginLocks,
  recordLoginFail,
  clearAccount,
  accountKey,
} from "@/lib/auth/loginLimiter";

const ADMISSION_ERRORS = {
  denied: "sso_group_denied",
  groups_unavailable: "sso_groups_unavailable",
  disabled: "account_disabled",
  sync_failed: "sso_sync_failed",
};

export async function POST(request) {
  const settings = await getSettings();
  const origin = getSamlBaseUrl(request, settings);
  const ip = getClientIp(request);

  // Snapshot then clear transient state first, so every exit (including the
  // security-state and lock returns below) leaves no state or invite cookie.
  const cookieStore = await cookies();
  const storedRequestId = cookieStore.get("saml_state")?.value || "";
  // YAN-360: captured for later; opened only after the assertion verifies.
  const sealedInvite = cookieStore.get(SAML_INVITE_COOKIE)?.value;
  // YAN-360: a transfer claims this ACS only when its cookie opens as a SAML
  // flow and no normal login is in flight (SAML start drops the transfer
  // cookie; transfer start drops saml_state). A stale/tampered one is dropped
  // and the normal login proceeds untouched.
  const sealedTransfer = cookieStore.get(OWNER_TRANSFER_COOKIE)?.value;
  const opened = sealedTransfer ? await openOwnerTransferState(sealedTransfer) : null;
  const transfer =
    opened?.provider === "saml" && opened.requestId && !storedRequestId ? opened : null;
  cookieStore.delete(OWNER_TRANSFER_COOKIE);
  cookieStore.delete("saml_state");
  cookieStore.delete(SAML_INVITE_COOKIE);

  // Runs before any login logic, never mints a session; once claimed, any
  // defect fails closed (no login fallback).
  if (transfer) {
    const st = transfer;
    const account = accountKey({ userId: st.ownerId });
    const failed = () => {
      recordLoginFail({ ip, account });
      return NextResponse.redirect(new URL("/login?error=ownership_reauth_failed", origin));
    };
    try {
      if (!(await isMultiUserEnabled())) return failed();
      if (checkLoginLocks({ ip, account }).locked) return failed();
      if (!resolveAuthModes(settings).saml || !isSamlConfigured(settings)) return failed();
      const SAMLResponse = (await request.formData()).get("SAMLResponse");
      if (!SAMLResponse) return failed();
      // Signature and InResponseTo are checked against this flow's request ID.
      const profile = await validateSamlResponse(request, { SAMLResponse }, st.requestId, settings);
      const { authnInstant } = verifyFreshSamlAuthnInstant(profile, { startedAt: st.startedAt });
      await completeSsoOwnershipTransfer({
        state: st,
        provider: "saml",
        issuer: profile.issuer || "",
        subject: profile.nameID,
        authenticatedAtMs: authnInstant,
      });
    } catch (err) {
      console.warn("[SAML] ownership re-auth failed:", err?.code || "error");
      return failed();
    }
    clearAccount(account);
    // Both owners' sessions were revoked by the sessionVersion bump.
    cookieStore.delete("auth_token");
    return NextResponse.redirect(new URL("/login?transferred=1", origin));
  }

  let enforced;
  try {
    enforced = await isUserSecurityEnforced();
  } catch {
    console.warn("[SAML] ACS failed: security_state_unavailable");
    return NextResponse.redirect(new URL("/login?error=saml_acs_failed", origin));
  }
  let account;
  const fail = (code) => {
    recordLoginFail({ ip, account });
    console.warn("[SAML] ACS denied:", code);
    audit(
      { ip },
      "auth.loginFailed",
      { type: "user" },
      { after: { provider: "saml", reason: code }, result: "failure" },
    );
    return NextResponse.redirect(new URL(`/login?error=${code}`, origin));
  };
  const lock = enforced ? checkLoginLocks({ ip }) : checkLock(ip);
  if (lock.locked) {
    return NextResponse.redirect(new URL("/login?error=too_many_attempts", origin));
  }

  try {
    const formData = await request.formData();
    const SAMLResponse = formData.get("SAMLResponse");

    if (!SAMLResponse) {
      if (enforced) return fail("saml_missing_response");
      recordFail(ip);
      return NextResponse.redirect(new URL("/login?error=saml_missing_response", origin));
    }

    if (!resolveAuthModes(settings).saml || !isSamlConfigured(settings)) {
      if (enforced) return fail("saml_not_configured");
      console.warn("[SAML] ACS failed: saml_not_configured");
      recordFail(ip);
      return NextResponse.redirect(new URL("/login?error=saml_not_configured", origin));
    }

    const profile = await validateSamlResponse(
      request,
      { SAMLResponse },
      storedRequestId,
      settings,
    );

    // YAN-360: a present invite proof must open for exactly this flow's request
    // ID, else fail closed (never a silent ordinary login). Not logged.
    let invitationToken;
    if (sealedInvite) {
      invitationToken = (await openSamlInvite(sealedInvite, storedRequestId)) || undefined;
      // Invites need admission (enforced security); never degrade to a plain login.
      if (!invitationToken || !enforced) throw new SsoAdmissionError("denied");
    }

    const samlEmail = pickSamlEmail(profile, settings) || null;
    const samlName = pickSamlDisplayName(profile, settings) || "SAML user";
    // Signed assertion (validateSamlResponse): an explicit, email-shaped email
    // claim counts as verified (ADR-0003). nameID/upn fallbacks never do.
    const verifiedEmail = pickVerifiedSamlEmail(profile, settings);

    const identity = {
      provider: "saml",
      issuer: profile.issuer || "",
      subject: profile.nameID,
      email: verifiedEmail ?? samlEmail,
      emailVerified: Boolean(verifiedEmail),
    };
    let opts;
    if (enforced) {
      if (
        typeof identity.issuer !== "string" ||
        !identity.issuer ||
        typeof identity.subject !== "string" ||
        !identity.subject ||
        profile.nameIDFormat === "urn:oasis:names:tc:SAML:2.0:nameid-format:transient"
      ) {
        console.warn("[SAML] ACS denied: stable issuer and persistent NameID required");
        throw new SsoAdmissionError("denied");
      }
      account = `sso:${JSON.stringify([identity.provider, identity.issuer, identity.subject])}`;
      if (checkLoginLocks({ ip, account }).locked) {
        return NextResponse.redirect(new URL("/login?error=too_many_attempts", origin));
      }
      const source = pickSamlGroups(profile, settings);
      if (!source.present || source.invalid || !Array.isArray(source.groups)) {
        throw new SsoAdmissionError("groups_unavailable");
      }
      const admitted = await ssoAdmit({ ...identity, displayName: samlName }, source.groups, {
        setupToken: cookieStore.get(SETUP_TOKEN_COOKIE)?.value,
        ...(invitationToken ? { invitationToken } : {}),
      });
      takeSetupToken(cookieStore);
      if (admitted.kind === "pending") {
        clearAccount(account);
        audit(
          { ip },
          "auth.loginPending",
          { type: "user", id: admitted.userId },
          { after: { provider: "saml", reason: "pending" }, result: "pending" },
        );
        return NextResponse.redirect(new URL("/login/pending", origin));
      }
      opts = { admittedUserId: admitted.userId };
    } else {
      opts = { setupToken: takeSetupToken(cookieStore) };
    }
    const claims = await sessionClaims("saml", identity, opts);
    if (!claims) {
      if (enforced) return fail("sso_sync_failed");
      audit(
        { ip },
        "auth.loginFailed",
        { type: "user" },
        { after: { provider: "saml", reason: "notLinked" }, result: "failure" },
      );
      return NextResponse.redirect(new URL("/login?error=sso_not_linked", origin));
    }
    if (!enforced) recordSuccess(ip);

    await setDashboardAuthCookie(cookieStore, request, {
      ...claims,
      saml: true,
      samlEmail,
      samlName,
    });
    if (enforced) clearAccount(account);
    audit(
      { principal: claims.sub ? { userId: claims.sub, via: "session" } : null, ip },
      "auth.login",
      { type: "user", id: claims.sub ?? null },
      { after: { provider: "saml" } },
    );

    return NextResponse.redirect(new URL("/dashboard", origin));
  } catch (error) {
    if (enforced) {
      return fail(
        error instanceof SsoAdmissionError
          ? ADMISSION_ERRORS[error.code] || "sso_sync_failed"
          : "saml_acs_failed",
      );
    }
    console.warn("[SAML] ACS failed:", error?.message || error);
    recordFail(ip);
    audit(
      { ip },
      "auth.loginFailed",
      { type: "user" },
      { after: { provider: "saml", reason: "error" }, result: "failure" },
    );
    return NextResponse.redirect(new URL("/login?error=saml_acs_failed", origin));
  }
}
