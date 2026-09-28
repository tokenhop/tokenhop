"use client";

import { Suspense, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { useSearchParams } from "next/navigation";
import { Card, CopyField } from "@/shared/components";

const STATE_VIEWS = {
  processing: {
    icon: "progress_activity",
    tile: "bg-coral-bg text-coral-ink",
    spin: true,
    title: "Processing...",
    body: "Please wait while we complete the authorization.",
  },
  success: {
    icon: "check_circle",
    tile: "bg-ok-bg text-ok",
    title: "Authorization successful",
    body: "This window will close automatically...",
  },
  done: {
    icon: "check_circle",
    tile: "bg-ok-bg text-ok",
    title: "Authorization successful",
    body: "You can close this tab now.",
  },
  manual: {
    icon: "info",
    tile: "bg-sky-bg text-sky",
    title: "Copy this URL",
    body: "Please copy the URL from the address bar and paste it in the application.",
  },
};

/** Centered Signal status card for the OAuth callback states. */
function CallbackStatus({ state, children }) {
  const view = STATE_VIEWS[state];
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-4">
      <Card className="w-full max-w-md text-center" padding="lg">
        <div role="status" aria-live="polite" className="flex flex-col items-center gap-3">
          <span
            className={`flex size-14 items-center justify-center rounded-2xl ${view.tile}`}
            aria-hidden="true"
          >
            <span
              className={`material-symbols-outlined text-[28px]${view.spin ? " motion-safe:animate-spin" : ""}`}
            >
              {view.icon}
            </span>
          </span>
          <h1 className="font-display text-2xl font-bold tracking-[-0.02em] text-text">
            {view.title}
          </h1>
          <p className="text-sm text-muted">{view.body}</p>
        </div>
        {children}
      </Card>
    </main>
  );
}

CallbackStatus.propTypes = {
  state: PropTypes.oneOf(Object.keys(STATE_VIEWS)).isRequired,
  children: PropTypes.node,
};

/**
 * OAuth Callback Page Content
 */
function CallbackContent() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState("processing");

  useEffect(() => {
    const code = searchParams.get("code");
    const token = searchParams.get("token");
    const state = searchParams.get("state");
    const error = searchParams.get("error");
    const errorDescription = searchParams.get("error_description");

    const callbackData = {
      code,
      token,
      state,
      error,
      errorDescription,
      fullUrl: window.location.href,
    };

    // Relay the callback to the opener/other tabs. Each channel is best-effort;
    // the manual copy-URL state below covers the case where none reach a listener.
    // Trusted origins that may receive this callback. The OAuth code/state
    // must only be relayed to the dashboard window we expect to be the opener
    // (same origin) or the Codex helper that listens on a fixed loopback port.
    // Any other origin is treated as hostile (drive-by attacker that opened
    // the popup against the well-known redirect_uri to phish the code).
    const expectedOrigins = [
      window.location.origin, // Same origin (for most providers)
      "http://localhost:1455", // Codex specific port
    ];

    // Method 1: postMessage to opener (popup mode)
    // Send once per expected origin. The browser delivers the message only
    // when the opener's origin matches the targetOrigin we pass — using "*"
    // here would leak the code/state to any opener (e.g. an attacker page
    // that opened this URL in a popup), so iterate over the allowlist.
    if (window.opener) {
      for (const origin of expectedOrigins) {
        try {
          window.opener.postMessage({ type: "oauth_callback", data: callbackData }, origin);
        } catch (e) {
          console.log("postMessage failed:", e);
        }
      }
    }

    // Method 2: BroadcastChannel (same origin tabs)
    try {
      const channel = new BroadcastChannel("oauth_callback");
      channel.postMessage(callbackData);
      channel.close();
    } catch (e) {
      console.log("BroadcastChannel failed:", e);
    }

    // Method 3: localStorage event (fallback)
    try {
      localStorage.setItem(
        "oauth_callback",
        JSON.stringify({ ...callbackData, timestamp: Date.now() }),
      );
    } catch (e) {
      console.log("localStorage failed:", e);
    }

    if (!(code || token || error)) {
      setTimeout(() => setStatus("manual"), 0);
      return;
    }

    setStatus("success");
    setTimeout(() => {
      window.close();
      setTimeout(() => setStatus("done"), 500);
    }, 1500);
  }, [searchParams]);

  return (
    <CallbackStatus state={status}>
      {status === "manual" && (
        <CopyField
          className="mt-5 text-start"
          value={typeof window !== "undefined" ? window.location.href : ""}
          label="Copy callback URL"
        />
      )}
    </CallbackStatus>
  );
}

/**
 * OAuth Callback Page
 * Receives callback from OAuth providers and sends data back via multiple methods
 */
export default function CallbackPage() {
  return (
    <Suspense fallback={<CallbackStatus state="processing" />}>
      <CallbackContent />
    </Suspense>
  );
}
