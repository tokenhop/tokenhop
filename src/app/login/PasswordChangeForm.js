"use client";

import { useState } from "react";
import Button from "@/shared/components/Button";
import Callout from "@/shared/components/Callout";
import Input from "@/shared/components/Input";

const DEFAULT_MIN_LENGTH = 8;

/**
 * Password change form for the login page.
 * - mode "restricted": forced change after login (no full session yet). The typed
 *   temporary password arrives as `currentPassword`; if empty (page reloaded) the
 *   form asks for it.
 * - mode "self": signed-in user at /login?changePassword=1; always asks for the
 *   current password.
 * Both POST { currentPassword, newPassword } to /api/auth/change-password.
 *
 * @param {object} props
 * @param {"restricted"|"self"} props.mode
 * @param {string} [props.login] Account shown in the copy, when known.
 * @param {string} [props.currentPassword] Temporary password kept in memory.
 * @param {number} [props.minLength] Server minimum length.
 * @param {(message: string) => void} props.onExpired Challenge/session expired; back to login.
 */
export default function PasswordChangeForm({
  mode,
  login = "",
  currentPassword: initialCurrent = "",
  minLength,
  onExpired,
}) {
  const min = Number(minLength) > 0 ? Number(minLength) : DEFAULT_MIN_LENGTH;
  const needsCurrent = mode === "self" || !initialCurrent;
  const [current, setCurrent] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (newPassword.length < min) {
      setError(`New password must be at least ${min} characters.`);
      return;
    }
    if (newPassword !== confirm) {
      setError("New password and confirmation do not match.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: needsCurrent ? current : initialCurrent,
          newPassword,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setCurrent("");
        setNewPassword("");
        setConfirm("");
        window.location.assign(data.startPage || "/dashboard");
        return;
      }
      if (data.code === "password_change_expired") {
        onExpired(data.error || "Your password change session expired. Sign in again.");
        return;
      }
      setError(data.error || "Failed to change password");
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const heading =
    mode === "self"
      ? "Change your password"
      : login
        ? `Changing password for ${login}`
        : "Choose a new password";

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Callout
        variant="warn"
        title={mode === "self" ? "Change password" : "Password change required"}
      >
        {heading}
      </Callout>
      {needsCurrent && (
        <Input
          label={mode === "self" ? "Current password" : "Temporary password"}
          required
          type="password"
          name="currentPassword"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoFocus
        />
      )}
      <Input
        label="New password"
        required
        type="password"
        name="newPassword"
        autoComplete="new-password"
        placeholder="Enter new password"
        hint={`At least ${min} characters.`}
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        autoFocus={!needsCurrent}
      />
      <Input
        label="Confirm new password"
        required
        type="password"
        name="confirmPassword"
        autoComplete="new-password"
        placeholder="Repeat new password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      <div aria-live="assertive">
        {error && (
          <Callout variant="err" title="Could not change password">
            {error}
          </Callout>
        )}
      </div>
      <Button
        type="submit"
        variant="primary"
        fullWidth
        loading={loading}
        disabled={!newPassword || !confirm || (needsCurrent && !current)}
      >
        Set password
      </Button>
    </form>
  );
}
