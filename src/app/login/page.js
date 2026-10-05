"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Button from "@/shared/components/Button";
import Callout from "@/shared/components/Callout";
import Card from "@/shared/components/Card";
import Input from "@/shared/components/Input";
import { SkeletonText } from "@/shared/components/Loading";
import BrandLockup from "@/shared/components/BrandLockup";
import { ACTIVE } from "@/shared/brand";
import { resolveLoginVisibility } from "./loginVisibility";
import { resolveAuthModes } from "@/lib/auth/authModes";
import { describeLoginError } from "./loginErrors";
import PasswordChangeForm from "./PasswordChangeForm";

/**
 * Login page: password form, SSO buttons per auth mode, forced-change flow,
 * first-run default-password warning, and rate-limit states.
 * With multi-user security established, an identifier field appears above the
 * password and the login POST carries { login, password }.
 */
export default function LoginPage() {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [resetHint, setResetHint] = useState("");
  const [retryAfter, setRetryAfter] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasPassword, setHasPassword] = useState(null);
  const [authMode, setAuthMode] = useState("password");
  const [ssoType, setSsoType] = useState("oidc");
  const [oidcConfigured, setOidcConfigured] = useState(false);
  const [oidcLoginLabel, setOidcLoginLabel] = useState("Sign in with OIDC");
  const [samlConfigured, setSamlConfigured] = useState(false);
  const [samlLoginLabel, setSamlLoginLabel] = useState("Sign in with SAML SSO");
  // null = loading, "login" = password form, "restricted" = forced change,
  // "self" = signed-in self-service change at /login?changePassword=1.
  const [view, setView] = useState("login");
  const [passwordMinLength, setPasswordMinLength] = useState(8);
  const [multiUserActive, setMultiUserActive] = useState(false);
  const [ssoError, setSsoError] = useState("");

  // Show the SSO redirect's ?error= once, then strip it from the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("error");
    if (!code) return;
    setSsoError(describeLoginError(code));
    params.delete("error");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, []);

  // Countdown for rate-limit
  useEffect(() => {
    if (retryAfter <= 0) return;
    const id = setInterval(() => setRetryAfter((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [retryAfter]);

  useEffect(() => {
    let cancelled = false;
    async function checkAuth() {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
      const params =
        typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
      const selfChange = params?.get("changePassword") === "1";

      try {
        const res = await fetch(`${baseUrl}/api/auth/status`, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (cancelled) return;

        if (res.ok) {
          const data = await res.json();
          if (data.mustChangePassword === true) {
            // Live password-change challenge (no full session). Reload-safe.
            setMultiUserActive(data.multiUserActive === true);
            setHasPassword(!!data.hasPassword);
            setView("restricted");
            return;
          }
          if (data.authenticated === true || data.requireLogin === false) {
            if (selfChange && data.userSecurityEnforced === true) {
              // Signed-in self-service change; query alone never authorizes it.
              setMultiUserActive(data.multiUserActive === true);
              setHasPassword(!!data.hasPassword);
              setView("self");
              return;
            }
            window.location.assign("/dashboard");
            return;
          }
          setMultiUserActive(data.multiUserActive === true);
          setHasPassword(!!data.hasPassword);
          setAuthMode(data.authMode || "password");
          setSsoType(data.ssoType || "oidc");
          setOidcConfigured(data.oidcConfigured === true);
          setOidcLoginLabel(data.oidcLoginLabel || "Sign in with OIDC");
          setSamlConfigured(data.samlConfigured === true);
          setSamlLoginLabel(data.samlLoginLabel || "Sign in with SAML SSO");
        } else {
          // Safe fallback on non-OK response to avoid infinite loading state.
          setHasPassword(true);
        }
      } catch {
        clearTimeout(timeoutId);
        if (!cancelled) setHasPassword(true);
      }
    }
    checkAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResetHint("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(multiUserActive ? { login, password } : { password }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        window.location.assign(data.startPage || "/dashboard");
        return;
      }

      if (data.code === "password_change_required") {
        // No full session was issued; change it now with the typed temp password.
        setPasswordMinLength(Number(data.passwordMinLength) || 8);
        setView("restricted");
        return;
      }

      if (data.code === "default_password_remote") {
        // Remote public-default: no challenge cookie exists, so never open
        // the change form; show the server's local-recovery guidance as-is.
        setError(data.error || "Sign in from the machine running this server to continue.");
      } else if (data.code) {
        setError(describeLoginError(data.code));
      } else {
        setError(data.error || "Invalid password");
      }
      if (data.resetHint) setResetHint(data.resetHint);
      if (data.retryAfter) setRetryAfter(Number(data.retryAfter));
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // password_change_expired: back to the plain login form with a message.
  const handleExpired = (message) => {
    setView("login");
    setPassword("");
    setError(message);
  };

  const handleOidcLogin = () => {
    window.location.href = "/api/auth/oidc/start";
  };

  const handleSamlLogin = () => {
    window.location.href = "/api/auth/saml/start";
  };

  const { samlAvailable, oidcAvailable, passwordAvailable } = resolveLoginVisibility({
    authMode,
    ssoType,
    oidc: oidcConfigured,
    saml: samlConfigured,
  });
  const modes = resolveAuthModes({ authMode, ssoType });
  const isSsoEnabled = modes.oidc || modes.saml;
  const activeSsoType = modes.protocol;
  const ssoAvailable = samlAvailable || oidcAvailable;

  // Show loading state while checking password
  if (hasPassword === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg p-4">
        <Card className="w-full max-w-md">
          <div role="status" aria-label="Loading sign-in">
            <SkeletonText lines={3} />
          </div>
        </Card>
      </div>
    );
  }

  const subtitle =
    view === "self"
      ? "Change your password"
      : multiUserActive
        ? "Sign in with your account"
        : samlAvailable
          ? "Sign in with SAML 2.0 Single Sign-On"
          : oidcAvailable
            ? "Sign in with your OIDC provider to access the dashboard"
            : "Enter your password to access the dashboard";

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-bg p-4">
      <div className="relative z-10 w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="sr-only">{`Login to ${ACTIVE.name}`}</h1>
          <Link
            href="/landing"
            className="inline-flex items-center gap-2.5 focus-visible:outline-none focus-visible:shadow-focus"
            aria-label={`${ACTIVE.name} home`}
          >
            <BrandLockup size={44} />
          </Link>
          <p className="mt-4 text-sm text-muted">{subtitle}</p>
        </div>

        <Card>
          {view === "restricted" ? (
            <PasswordChangeForm
              mode="restricted"
              login={multiUserActive ? login : ""}
              currentPassword={password}
              minLength={passwordMinLength}
              onExpired={handleExpired}
            />
          ) : view === "self" ? (
            <PasswordChangeForm mode="self" minLength={8} onExpired={handleExpired} />
          ) : (
            <div className="flex flex-col gap-4">
              {ssoError && (
                <Callout variant="err" title="Sign-in failed">
                  {ssoError}
                </Callout>
              )}

              {samlAvailable && (
                <Button type="button" variant="secondary" fullWidth onClick={handleSamlLogin}>
                  {samlLoginLabel}
                </Button>
              )}

              {oidcAvailable && (
                <Button type="button" variant="secondary" fullWidth onClick={handleOidcLogin}>
                  {oidcLoginLabel}
                </Button>
              )}

              {ssoAvailable && passwordAvailable && <div className="h-px bg-line" />}

              {passwordAvailable ? (
                <form onSubmit={handleLogin} className="flex flex-col gap-4">
                  {isSsoEnabled && !ssoAvailable && (
                    <Callout variant="warn">
                      {activeSsoType === "saml" ? "SAML SSO" : "OIDC"} login is enabled, but
                      configuration is incomplete. Password login is still available for recovery.
                    </Callout>
                  )}

                  {authMode === "both" && ssoAvailable && (
                    <p className="text-center text-xs text-muted">
                      Password and {activeSsoType === "saml" ? "SAML SSO" : "OIDC"} login are both
                      enabled.
                    </p>
                  )}

                  <div aria-live="assertive">
                    {error && <span className="sr-only">{error}</span>}
                  </div>

                  {multiUserActive && (
                    <Input
                      label="Email or username"
                      required
                      type="text"
                      name="username"
                      autoComplete="username"
                      placeholder="you@example.com or username"
                      value={login}
                      onChange={(e) => setLogin(e.target.value)}
                      autoFocus
                    />
                  )}

                  <Input
                    label="Password"
                    required
                    type="password"
                    name="password"
                    autoComplete="current-password"
                    placeholder="Enter password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    error={error || undefined}
                    autoFocus={!multiUserActive && !oidcAvailable}
                  />
                  {retryAfter > 0 && (
                    <p className="text-xs text-warn" role="status">
                      Locked. Retry in <span className="font-mono">{retryAfter}s</span>.
                    </p>
                  )}
                  {resetHint && !multiUserActive && (
                    <p className="text-xs text-muted">
                      Forgot password? Open <code className="font-mono">{ACTIVE.npmPackage}</code>{" "}
                      CLI on the host → <b>Settings</b> → <b>Reset password to default</b>.
                    </p>
                  )}
                  {multiUserActive && (
                    <p className="text-xs text-muted">
                      Forgot your password? Ask an admin to reset it for you.
                    </p>
                  )}

                  <Button
                    type="submit"
                    variant="primary"
                    fullWidth
                    loading={loading}
                    disabled={retryAfter > 0 || (multiUserActive && !login)}
                  >
                    {retryAfter > 0 ? `Wait ${retryAfter}s` : "Login"}
                  </Button>

                  {!multiUserActive && (
                    <p className="mt-2 text-center text-xs text-muted">
                      Default password is <code className="font-mono">123456</code>
                    </p>
                  )}
                  {hasPassword === false && (
                    <Callout variant="warn" title="Security risk">
                      No password set. You will be asked to set one when logging in remotely.
                    </Callout>
                  )}
                </form>
              ) : (
                error && (
                  <Callout variant="err" title="Sign-in failed">
                    {error}
                  </Callout>
                )
              )}
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}
