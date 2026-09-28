"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Legacy pricing URL: redirects to the Pricing section of `/dashboard/settings`,
 * preserving the edit-modal intent (`?editPricing=1`).
 */
export default function LegacyPricingRedirect() {
  const router = useRouter();

  useEffect(() => {
    const hash = window.location.hash || "#pricing";
    router.replace(`/dashboard/settings${window.location.search}${hash}`);
  }, [router]);

  return (
    <p className="p-6 text-sm text-muted">
      Pricing moved to <a href="/dashboard/settings#pricing">/dashboard/settings#pricing</a>.
    </p>
  );
}
