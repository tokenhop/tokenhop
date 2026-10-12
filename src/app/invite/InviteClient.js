"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import BrandLockup from "@/shared/components/BrandLockup";
import Button from "@/shared/components/Button";
import Callout from "@/shared/components/Callout";
import Card from "@/shared/components/Card";
import Input from "@/shared/components/Input";
import { SkeletonText } from "@/shared/components/Loading";
import { ACTIVE } from "@/shared/brand";
import { resolveAuthModes } from "@/lib/auth/authModes";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export default function InviteClient() {
  const initialized = useRef(false);
  const [token, setToken] = useState(null);
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryAfter, setRetryAfter] = useState(0);
  const [workspace, setWorkspace] = useState(null);
  const [alreadyMember, setAlreadyMember] = useState(false);
  const [form, setForm] = useState({
    email: "",
    username: "",
    displayName: "",
    password: "",
    confirmPassword: "",
  });

  useEffect(() => {
    // A newly pasted hash link may reuse this route without a full remount.
    const onHash = () => {
      const next = new URLSearchParams(window.location.hash.slice(1)).get("token");
      if (!next) return;
      window.history.replaceState(null, "", window.location.pathname);
      setWorkspace(null);
      setAlreadyMember(false);
      setStatus(null);
      setError("");
      setChecking(TOKEN_RE.test(next));
      setToken(next);
      if (!TOKEN_RE.test(next)) setError("This invitation link is not valid.");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    // Strict Mode replays effects: never reread the already-scrubbed URL.
    if (initialized.current) return;
    initialized.current = true;
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const query = new URLSearchParams(window.location.search);
    const invitationToken = hash.get("token") ?? "";
    hash.delete("token");
    query.delete("token");
    const search = query.toString();
    const fragment = hash.toString();
    // null state: Next's patched history then syncs its own canonical URL too,
    // so a later router re-render cannot put the token back in the address bar.
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${search ? `?${search}` : ""}${fragment ? `#${fragment}` : ""}`,
    );
    setToken(invitationToken);
    if (!TOKEN_RE.test(invitationToken)) {
      setError("This invitation link is not valid.");
      setChecking(false);
    }
  }, []);

  const showServerError = useCallback((response, data) => {
    if (response.status === 404) {
      setError("Invitations are not available on this instance.");
    } else if (response.status === 429) {
      const seconds = Number(response.headers.get("Retry-After") ?? data.retryAfter);
      const delay = Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : 0;
      setRetryAfter(delay);
      setError(`${data.error || "Too many attempts."} Retry in ${delay} seconds.`);
    } else if (response.status === 409 && data.code === "already_member") {
      setAlreadyMember(true);
      setToken("");
      return;
    } else if (data.code === "invite_invalid") {
      setError("This invitation is invalid or has expired.");
    } else {
      setError(data.error || "Could not accept the invitation. Please try again.");
    }
  }, []);

  useEffect(() => {
    if (token === null || !TOKEN_RE.test(token)) return;
    const controller = new AbortController();
    let cancelled = false;
    const timeout = setTimeout(() => controller.abort(), 10000);
    async function loadStatus() {
      try {
        const response = await fetch("/api/auth/status", {
          signal: controller.signal,
          cache: "no-store",
          referrerPolicy: "no-referrer",
        });
        const data = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          showServerError(response, data);
          return;
        }
        setStatus(data);
      } catch {
        if (!cancelled) setError("Could not load account status. Please try again.");
      } finally {
        clearTimeout(timeout);
        if (!cancelled) setChecking(false);
      }
    }
    loadStatus();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [token, showServerError]);

  useEffect(() => {
    if (retryAfter <= 0) return;
    const timer = setInterval(() => setRetryAfter((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearInterval(timer);
  }, [retryAfter]);

  const user = status?.principal?.user;
  const modes = resolveAuthModes(status || {});
  const disabled = busy || retryAfter > 0;

  async function submit(protocol) {
    if (disabled || !TOKEN_RE.test(token)) return;
    setError("");
    setBusy(true);
    try {
      const body = protocol
        ? { invitationToken: token }
        : user
          ? { token }
          : {
              token,
              email: form.email,
              username: form.username,
              displayName: form.displayName,
              password: form.password,
            };
      const response = await fetch(
        protocol ? `/api/auth/${protocol}/start` : "/api/invitations/accept",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          referrerPolicy: "no-referrer",
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        showServerError(response, data);
        return;
      }
      if (protocol) {
        const redirectUrl = data.redirectUrl || data.authorizeUrl;
        if (!redirectUrl) throw new Error("Missing SSO redirect");
        const target = new URL(redirectUrl, window.location.origin);
        if (target.protocol !== "https:" && target.protocol !== "http:") {
          throw new Error("Invalid SSO redirect");
        }
        window.location.assign(target.href);
        return;
      }
      setWorkspace(
        data.workspaceName ||
          data.workspace?.name ||
          status.principal?.workspaces?.find((item) => item.id === data.workspaceId)?.name ||
          data.workspaceId ||
          "the workspace",
      );
      setToken("");
      setForm({ email: "", username: "", displayName: "", password: "", confirmPassword: "" });
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function handleAccept(event) {
    event.preventDefault();
    if (!user && form.password !== form.confirmPassword) {
      setError("Password and confirmation do not match.");
      return;
    }
    submit();
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-bg p-4">
      <div className="relative z-10 w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="sr-only">Join a workspace</h1>
          <Link
            href="/landing"
            className="inline-flex min-h-11 items-center gap-2.5 focus-visible:outline-none focus-visible:shadow-focus"
            aria-label={`${ACTIVE.name} home`}
          >
            <BrandLockup size={44} />
          </Link>
          <p className="mt-4 text-sm text-muted">Accept your workspace invitation</p>
        </div>
        <Card>
          {checking ? (
            <div role="status" aria-label="Loading invitation">
              <SkeletonText lines={3} />
            </div>
          ) : alreadyMember ? (
            <div className="flex flex-col gap-4">
              <Callout variant="info" title="You're already a member of this workspace">
                This invitation was not used, so it is still valid for someone else.
              </Callout>
              <Button href="/dashboard" fullWidth className="min-h-11">
                Go to dashboard
              </Button>
            </div>
          ) : workspace !== null ? (
            <div className="flex flex-col gap-4">
              <Callout variant="ok" title="Invitation accepted">
                {`You've joined ${workspace}`}
              </Callout>
              <Button href={user ? "/dashboard" : "/login"} fullWidth className="min-h-11">
                {user ? "Go to dashboard" : "Sign in"}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div aria-live="polite">
                {error && (
                  <Callout variant="err" title="Could not join">
                    {error}
                  </Callout>
                )}
              </div>
              {status && TOKEN_RE.test(token) && (
                <>
                  {user ? (
                    <form onSubmit={handleAccept} className="flex flex-col gap-4">
                      <h2 className="text-lg font-semibold text-text">
                        Join as {user.displayName || user.username || user.email || "your account"}
                      </h2>
                      <Button
                        type="submit"
                        fullWidth
                        loading={busy}
                        disabled={disabled}
                        className="min-h-11"
                      >
                        Accept
                      </Button>
                    </form>
                  ) : (
                    <>
                      {modes.oidc && status.oidcConfigured && (
                        <Button
                          type="button"
                          variant="secondary"
                          fullWidth
                          disabled={disabled}
                          loading={busy}
                          className="min-h-11"
                          onClick={() => submit("oidc")}
                        >
                          Continue with {status.oidcLoginLabel || "OIDC"}
                        </Button>
                      )}
                      {modes.saml && status.samlConfigured && (
                        <Button
                          type="button"
                          variant="secondary"
                          fullWidth
                          disabled={disabled}
                          loading={busy}
                          className="min-h-11"
                          onClick={() => submit("saml")}
                        >
                          Continue with {status.samlLoginLabel || "SAML SSO"}
                        </Button>
                      )}
                      <form onSubmit={handleAccept} className="flex flex-col gap-4">
                        <h2 className="text-lg font-semibold text-text">Create your account</h2>
                        {[
                          ["email", "Email", "email", "email"],
                          ["username", "Username", "text", "username"],
                          ["displayName", "Display name", "text", "name"],
                          ["password", "Password", "password", "new-password"],
                          ["confirmPassword", "Confirm password", "password", "new-password"],
                        ].map(([name, label, type, autoComplete]) => (
                          <Input
                            key={name}
                            id={`invite-${name}`}
                            name={name}
                            label={label}
                            type={type}
                            autoComplete={autoComplete}
                            value={form[name]}
                            onChange={(event) =>
                              setForm((current) => ({ ...current, [name]: event.target.value }))
                            }
                            required
                            disabled={disabled}
                            inputClassName="min-h-11"
                          />
                        ))}
                        <Button
                          type="submit"
                          fullWidth
                          loading={busy}
                          disabled={disabled}
                          className="min-h-11"
                        >
                          Create account and accept
                        </Button>
                      </form>
                    </>
                  )}
                  {retryAfter > 0 && (
                    <p className="text-xs text-warn" role="status">
                      Retry in {retryAfter} seconds.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}
