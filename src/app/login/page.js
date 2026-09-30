"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Button from "@/shared/components/Button";
import Callout from "@/shared/components/Callout";
import Card from "@/shared/components/Card";
import Input from "@/shared/components/Input";
import { SkeletonText } from "@/shared/components/Loading";
import { resolveLoginVisibility } from "./loginVisibility";

/**
 * Login page: password form, SSO buttons per auth mode, must-change flow,
 * first-run default-password warning, and rate-limit states.
 * Auth/session logic is unchanged; only presentation uses Signal primitives.
 */
export default function LoginPage() {
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
  const [mustChange, setMustChange] = useState(false);
  const [newPassword, setNewPassword] = useState("");

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

      try {
        const res = await fetch(`${baseUrl}/api/auth/status`, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (cancelled) return;

        if (res.ok) {
          const data = await res.json();
          if (data.authenticated === true || data.requireLogin === false) {
            window.location.assign("/dashboard");
            return;
          }
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
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.mustChangePassword) {
          setMustChange(true);
          return;
        }
        window.location.assign(data.startPage || "/dashboard");
      } else {
        const data = await res.json();
        setError(data.error || "Invalid password");
        if (data.resetHint) setResetHint(data.resetHint);
        if (data.retryAfter) setRetryAfter(Number(data.retryAfter));
      }
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // Force a new password before entering the dashboard (default + remote).
  const handleSetNewPassword = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: password, newPassword }),
      });
      if (res.ok) {
        // YAN-312: honor the configured start page after the forced reset too.
        const data = await res.json().catch(() => ({}));
        window.location.assign(data.startPage || "/dashboard");
      } else {
        const data = await res.json();
        setError(data.error || "Failed to set password");
      }
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
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
  const isSsoEnabled = ["sso", "oidc", "saml", "both"].includes(authMode);
  const ssoAvailable = samlAvailable || oidcAvailable;
  const activeSsoType = ssoType || (authMode === "saml" ? "saml" : "oidc");

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

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-bg p-4">
      <div className="relative z-10 w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="sr-only">Login to 9Router</h1>
          <Link
            href="/landing"
            className="inline-flex items-center gap-2.5 focus-visible:outline-none focus-visible:shadow-focus"
            aria-label="9Router home"
          >
            <span
              className="flex size-11 -rotate-[8deg] items-center justify-center rounded-[11px] bg-coral font-display text-2xl font-extrabold text-on-coral shadow-card"
              aria-hidden="true"
            >
              9
            </span>
            <span className="font-display text-[26px] font-bold tracking-[-0.02em] text-text">
              router
            </span>
          </Link>
          <p className="mt-4 text-sm text-muted">
            {samlAvailable
              ? "Sign in with SAML 2.0 Single Sign-On"
              : oidcAvailable
                ? "Sign in with your OIDC provider to access the dashboard"
                : "Enter your password to access the dashboard"}
          </p>
        </div>

        <Card>
          {mustChange ? (
            <form onSubmit={handleSetNewPassword} className="flex flex-col gap-4">
              <Callout variant="warn" title="Password change required">
                Set a new password before accessing the dashboard remotely.
              </Callout>
              <Input
                label="New password"
                required
                type="password"
                autoComplete="new-password"
                placeholder="Enter new password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                error={error || undefined}
                autoFocus
              />
              <Button
                type="submit"
                variant="primary"
                fullWidth
                loading={loading}
                disabled={!newPassword}
              >
                Set password
              </Button>
            </form>
          ) : (
            <div className="flex flex-col gap-4">
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

                  <Input
                    label="Password"
                    required
                    type="password"
                    autoComplete="current-password"
                    placeholder="Enter password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    error={error || undefined}
                    autoFocus={!oidcAvailable}
                  />
                  {retryAfter > 0 && (
                    <p className="text-xs text-warn" role="status">
                      Locked. Retry in <span className="font-mono">{retryAfter}s</span>.
                    </p>
                  )}
                  {resetHint && (
                    <p className="text-xs text-muted">
                      Forgot password? Open <code className="font-mono">9router</code> CLI on the
                      host → <b>Settings</b> → <b>Reset password to default</b>.
                    </p>
                  )}

                  <Button
                    type="submit"
                    variant="primary"
                    fullWidth
                    loading={loading}
                    disabled={retryAfter > 0}
                  >
                    {retryAfter > 0 ? `Wait ${retryAfter}s` : "Login"}
                  </Button>

                  <p className="mt-2 text-center text-xs text-muted">
                    Default password is <code className="font-mono">123456</code>
                  </p>
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
