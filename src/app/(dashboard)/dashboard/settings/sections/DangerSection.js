"use client";

import { useState } from "react";
import SectionCard from "@/shared/components/SectionCard";
import SettingRow from "@/shared/components/SettingRow";
import Button from "@/shared/components/Button";
import { ConfirmDialog } from "@/shared/components/Modal";

/**
 * Danger zone: log out (POST /api/auth/logout) and shut down
 * (POST /api/version/shutdown, behind a confirm dialog).
 */
export default function DangerSection() {
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  const handleLogout = async () => {
    setLogoutError("");
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (!res.ok) throw new Error("Failed to log out");
      window.location.assign("/login");
    } catch (err) {
      setLogoutError(err.message || "Failed to log out");
    }
  };

  const handleShutdown = async () => {
    try {
      await fetch("/api/version/shutdown", { method: "POST" });
    } catch {
      // Expected: the server stops before it can answer.
    }
    setShutdownOpen(false);
  };

  return (
    <div id="danger" className="scroll-mt-24 space-y-4">
      <SectionCard
        icon="warning"
        title="Danger zone"
        subtitle="End sessions and stop the server."
      />
      <div className="rounded-2xl border border-err/40 bg-panel p-5 shadow-card divide-y divide-line">
        <SettingRow
          label="Log out"
          description="End this dashboard session."
          control={
            <Button variant="secondary" icon="logout" onClick={handleLogout}>
              Log out
            </Button>
          }
        />
        {logoutError && (
          <p className="py-2 text-xs text-err" role="alert">
            {logoutError}
          </p>
        )}
        <SettingRow
          label="Shut down 9router"
          description="Your tools lose their endpoint until you start it again."
          control={
            <Button
              variant="danger"
              icon="power_settings_new"
              onClick={() => setShutdownOpen(true)}
            >
              Shut down
            </Button>
          }
        />
      </div>
      <ConfirmDialog
        isOpen={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdown}
        title="Shut down 9router"
        message="Your tools lose their endpoint until you start it again."
        confirmText="Shut down"
        variant="danger"
      />
    </div>
  );
}
