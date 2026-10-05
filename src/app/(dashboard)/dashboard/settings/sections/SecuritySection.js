"use client";

import PropTypes from "prop-types";
import { useEffect, useState } from "react";
import SectionCard from "@/shared/components/SectionCard";
import SettingRow from "@/shared/components/SettingRow";
import Toggle from "@/shared/components/Toggle";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Callout from "@/shared/components/Callout";
import CopyField from "@/shared/components/CopyField";
import { Skeleton } from "@/shared/components/Loading";
import useAuthStatus from "@/shared/hooks/useAuthStatus";
import { useSettingsField } from "../useSettingsField";

// Mirrors server MIN_PASSWORD_LENGTH (src/lib/auth/userPassword.js); server stays authoritative.
const MIN_PASSWORD_LENGTH = 8;

/**
 * Security & access section:
 * - requireLogin: optimistic toggle with rollback
 * - password change: current/new/confirm with client & server validation
 * - requireApiKey: optimistic toggle
 * - tunnelDashboardAccess: optimistic toggle
 * - secure session cookie: read-only AUTH_COOKIE_SECURE readout
 */
export default function SecuritySection({ settings, onSettingsChange }) {
  // Report to the page only after the server accepted the value (drives "All changes saved").
  const onSaved = (key) => (value) => onSettingsChange?.({ [key]: value });
  const requireLoginField = useSettingsField("requireLogin", settings.requireLogin !== false, {
    onSaved: onSaved("requireLogin"),
  });
  const requireApiKeyField = useSettingsField("requireApiKey", settings.requireApiKey !== false, {
    onSaved: onSaved("requireApiKey"),
  });
  const tunnelAccessField = useSettingsField(
    "tunnelDashboardAccess",
    settings.tunnelDashboardAccess !== false,
    { onSaved: onSaved("tunnelDashboardAccess") },
  );

  const [cookieSecure, setCookieSecure] = useState(null);
  const [cookieError, setCookieError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings/environment", { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) setCookieError(true);
          return;
        }
        const data = await res.json();
        if (!cancelled) setCookieSecure(data.cookieSecure === true ? "on" : "off");
      } catch {
        if (!cancelled) setCookieError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [passwords, setPasswords] = useState({ current: "", next: "", confirm: "" });
  const [passStatus, setPassStatus] = useState({ type: "", message: "" });
  const [passLoading, setPassLoading] = useState(false);
  // Established multi-user security: rotate through the self endpoint (any
  // user, current password required). Pristine installs keep PATCH /api/settings.
  const authStatus = useAuthStatus();
  // useAuthStatus starts as {}; a loaded status always carries `authenticated`.
  const authLoaded = Object.hasOwn(authStatus, "authenticated");
  const established = authStatus.userSecurityEnforced === true;
  const needsCurrent = established || settings.hasPassword;

  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    if (!authLoaded) return;
    if (passwords.next !== passwords.confirm) {
      setPassStatus({ type: "err", message: "Passwords do not match" });
      return;
    }
    if (!passwords.next) {
      setPassStatus({ type: "err", message: "New password cannot be empty" });
      return;
    }
    if (established && passwords.next.length < MIN_PASSWORD_LENGTH) {
      setPassStatus({
        type: "err",
        message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      });
      return;
    }
    setPassLoading(true);
    setPassStatus({ type: "", message: "" });
    try {
      const res = await fetch(established ? "/api/auth/change-password" : "/api/settings", {
        method: established ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: passwords.current,
          newPassword: passwords.next,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setPassStatus({
          type: "ok",
          message: established
            ? "Password updated. Other signed-in sessions were signed out."
            : "Password updated successfully",
        });
        setPasswords({ current: "", next: "", confirm: "" });
        onSettingsChange?.({ hasPassword: true });
      } else {
        setPassStatus({ type: "err", message: data.error || "Failed to update password" });
      }
    } catch {
      setPassStatus({ type: "err", message: "An error occurred while updating password" });
    } finally {
      setPassLoading(false);
    }
  };

  return (
    <div id="security" className="scroll-mt-24 space-y-4">
      <SectionCard
        icon="shield"
        title="Security & access"
        subtitle="Who can reach the dashboard and the API."
        status="ok"
        statusLabel="Protected"
      />
      <div className="rounded-2xl border border-line bg-panel p-5 shadow-card divide-y divide-line">
        <SettingRow
          label="Require login"
          description="Ask for the dashboard password first."
          settingKey="requireLogin"
          control={
            <Toggle
              checked={requireLoginField.value}
              onChange={(next) => requireLoginField.set(next)}
              disabled={requireLoginField.saving}
              aria-label="Require login"
            />
          }
        />
        {requireLoginField.error && (
          <p className="py-2 text-xs text-err" role="alert">
            {requireLoginField.error}
          </p>
        )}

        {/* Password change form */}
        <div className="py-4 space-y-4">
          <div>
            <p className="text-[15px] font-semibold text-text">Password</p>
            <p className="mt-0.5 text-[13px] text-muted">
              {established
                ? "Change your password. Your other signed-in sessions will be signed out."
                : "Change the dashboard password. Replace the default before exposing anything."}
            </p>
          </div>
          <form onSubmit={handlePasswordSubmit} className="space-y-3 max-w-xl">
            {needsCurrent && (
              <Input
                label="Current password"
                type="password"
                autoComplete="current-password"
                value={passwords.current}
                onChange={(e) => setPasswords((p) => ({ ...p, current: e.target.value }))}
                required
                disabled={passLoading}
                placeholder="Current password"
              />
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                label="New password"
                type="password"
                autoComplete="new-password"
                value={passwords.next}
                onChange={(e) => setPasswords((p) => ({ ...p, next: e.target.value }))}
                required
                disabled={passLoading}
                placeholder="New password"
                hint={
                  established
                    ? `At least ${MIN_PASSWORD_LENGTH} characters; 15 or more is better.`
                    : undefined
                }
              />
              <Input
                label="Confirm new password"
                type="password"
                autoComplete="new-password"
                value={passwords.confirm}
                onChange={(e) => setPasswords((p) => ({ ...p, confirm: e.target.value }))}
                required
                disabled={passLoading}
                placeholder="Confirm password"
              />
            </div>
            {passStatus.message && (
              <Callout
                variant={passStatus.type === "ok" ? "ok" : "err"}
                title={passStatus.message}
              />
            )}
            <Button
              type="submit"
              loading={passLoading}
              disabled={passLoading || !authLoaded || settings.hasPassword === undefined}
            >
              {needsCurrent ? "Update password" : "Set password"}
            </Button>
          </form>
        </div>

        <SettingRow
          label="Require API key"
          description="Requests without a valid key get a 401. Needed for the tunnel."
          settingKey="requireApiKey"
          control={
            <Toggle
              checked={requireApiKeyField.value}
              onChange={(next) => requireApiKeyField.set(next)}
              disabled={requireApiKeyField.saving}
              aria-label="Require API key"
            />
          }
        />
        {requireApiKeyField.error && (
          <p className="py-2 text-xs text-err" role="alert">
            {requireApiKeyField.error}
          </p>
        )}

        <SettingRow
          label="Dashboard over tunnel"
          description="Serve this dashboard on the public tunnel URL too."
          settingKey="tunnelDashboardAccess"
          control={
            <Toggle
              checked={tunnelAccessField.value}
              onChange={(next) => tunnelAccessField.set(next)}
              disabled={tunnelAccessField.saving}
              aria-label="Dashboard over tunnel"
            />
          }
        />
        {tunnelAccessField.error && (
          <p className="py-2 text-xs text-err" role="alert">
            {tunnelAccessField.error}
          </p>
        )}

        <SettingRow
          label="Secure session cookie"
          description="HTTPS-only cookie for the login session."
          settingKey="AUTH_COOKIE_SECURE"
          control={
            <div className="w-full sm:min-w-72 sm:max-w-sm">
              {cookieSecure ? (
                <CopyField value={cookieSecure} label="Copy secure cookie state" />
              ) : cookieError ? (
                <p className="text-sm text-err" role="alert">
                  Could not load cookie state
                </p>
              ) : (
                <div role="status" aria-label="Loading cookie state">
                  <Skeleton className="h-11 w-full" />
                </div>
              )}
            </div>
          }
        />
      </div>
    </div>
  );
}

SecuritySection.propTypes = {
  settings: PropTypes.object.isRequired,
  onSettingsChange: PropTypes.func,
};
