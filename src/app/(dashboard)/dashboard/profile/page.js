"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Legacy profile route: permanently redirects to `/dashboard/settings`.
 * Preserves the section hash where present (e.g. `#sso`).
 */
export default function ProfileRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace(`/dashboard/settings${window.location.search}${window.location.hash}`);
  }, [router]);

  return (
    <p className="p-6 text-sm text-muted">
      Settings moved to <a href="/dashboard/settings">/dashboard/settings</a>.
    </p>
  );
}
