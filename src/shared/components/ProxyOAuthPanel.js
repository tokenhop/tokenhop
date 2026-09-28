"use client";

import PropTypes from "prop-types";
import Button from "./Button";
import Callout from "./Callout";
import CopyField from "./CopyField";
import Input from "./Input";
import { Spinner } from "./Loading";

// Providers offering a paste-token fallback (import-token flow).
// UX warns if the IDE (which issues the token) is not installed.
export const PASTE_TOKEN_PROVIDERS = {
  trae: {
    label: "Cloud-IDE-JWT",
    instructions:
      "Sign in at trae.ai (or solo.trae.ai), open DevTools → Network, copy the Cloud-IDE-JWT token from any request's Authorization header (~14-day lifetime).",
    placeholder: "Paste Cloud-IDE-JWT here...",
    ideName: "Trae",
    ideOptional: true, // token can be grabbed from DevTools without the IDE
  },
  windsurf: {
    label: "Windsurf API key",
    instructions:
      'In the Windsurf/VS Code IDE, run the "Windsurf: Provide Auth Token" command, then copy the displayed sk-ws-... key.',
    placeholder: "Paste sk-ws-... key here...",
    ideName: "Windsurf",
    ideOptional: false,
  },
};

const MODE_TAB = {
  browser: { icon: "language", label: "Sign in with browser" },
  "paste-token": { icon: "key", label: "Paste token" },
};

function modeTabClass(active) {
  return `inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:shadow-focus ${
    active
      ? "border-coral bg-coral-bg text-coral-ink"
      : "border-line text-muted hover:bg-raised hover:text-text"
  }`;
}

/**
 * Trae/Windsurf/Zed dynamic-port proxy flow. Browser mode waits for the local
 * callback proxy, but always offers a manual callback-URL paste: the redirect
 * targets 127.0.0.1 on the 9router host, which the browser cannot reach when
 * 9router runs in Docker or on another machine.
 */
export default function ProxyOAuthPanel({
  provider,
  step,
  authMode,
  authUrl,
  callbackUrl,
  onCallbackUrlChange,
  pasteToken,
  onPasteTokenChange,
  ideStatus,
  onSelectBrowser,
  onSelectPasteToken,
  onSubmit,
  onCancel,
}) {
  const pasteConfig = PASTE_TOKEN_PROVIDERS[provider];

  return (
    <>
      {pasteConfig && (
        <fieldset className="flex gap-2">
          <legend className="sr-only">Sign-in method</legend>
          <button
            type="button"
            onClick={onSelectBrowser}
            className={modeTabClass(authMode === "browser")}
            aria-pressed={authMode === "browser"}
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              {MODE_TAB.browser.icon}
            </span>
            {MODE_TAB.browser.label}
          </button>
          <button
            type="button"
            onClick={onSelectPasteToken}
            className={modeTabClass(authMode === "paste-token")}
            aria-pressed={authMode === "paste-token"}
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              {MODE_TAB["paste-token"].icon}
            </span>
            {MODE_TAB["paste-token"].label}
          </button>
        </fieldset>
      )}

      {authMode === "browser" && (step === "waiting" || step === "input") && (
        <>
          {step === "waiting" ? (
            <div
              role="status"
              className="flex items-center gap-2 rounded-xl border border-line bg-sky-bg px-3 py-2 text-sm text-text"
            >
              <Spinner size="sm" className="text-sky" />
              Waiting for browser authorization…
            </div>
          ) : (
            <p className="text-sm text-muted">
              Popup was blocked. Open the sign-in URL below in your browser.
            </p>
          )}

          <div className="flex items-center gap-3 py-1">
            <div className="h-px flex-1 bg-line" />
            <span className="text-xs uppercase tracking-wider text-muted">
              Or paste callback URL manually
            </span>
            <div className="h-px flex-1 bg-line" />
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">Step 1: Open this sign-in URL in your browser</p>
              <CopyField value={authUrl || ""} label="Copy sign-in URL" />
            </div>
            <Input
              label="Step 2: Paste the callback URL here"
              hint="After signing in, the browser is sent to a http://127.0.0.1:… address. If that page does not load (for example when 9router runs in Docker or on another machine), copy the full URL from the address bar and paste it here."
              value={callbackUrl}
              onChange={(e) => onCallbackUrlChange(e.target.value)}
              placeholder="http://127.0.0.1:.../?user_id=...&access_token=..."
              inputClassName="font-mono text-xs"
            />
          </div>

          <div className="flex gap-2">
            <Button onClick={onSubmit} fullWidth disabled={!callbackUrl.trim()}>
              Connect
            </Button>
            <Button onClick={onCancel} variant="ghost" fullWidth>
              Cancel
            </Button>
          </div>
        </>
      )}

      {authMode === "paste-token" && pasteConfig && (
        <div className="space-y-3">
          {ideStatus && !ideStatus.installed && (
            <Callout variant={pasteConfig.ideOptional ? "info" : "warn"} icon="info">
              {pasteConfig.ideName} IDE not detected.
              {pasteConfig.ideOptional
                ? " You can still grab the token from DevTools."
                : ` Install ${pasteConfig.ideName} IDE to get the token, or use "Sign in with browser".`}
            </Callout>
          )}
          <p className="text-sm text-muted">{pasteConfig.instructions}</p>
          <Input
            value={pasteToken}
            onChange={(e) => onPasteTokenChange(e.target.value)}
            placeholder={pasteConfig.placeholder}
            inputClassName="font-mono text-xs"
            aria-label={pasteConfig.label}
          />
          <div className="flex gap-2">
            <Button onClick={onSubmit} fullWidth disabled={!pasteToken.trim()}>
              Connect
            </Button>
            <Button onClick={onCancel} variant="ghost" fullWidth>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

ProxyOAuthPanel.propTypes = {
  provider: PropTypes.string.isRequired,
  step: PropTypes.oneOf(["waiting", "input", "success", "error"]).isRequired,
  authMode: PropTypes.oneOf(["browser", "paste-token"]).isRequired,
  authUrl: PropTypes.string,
  callbackUrl: PropTypes.string.isRequired,
  onCallbackUrlChange: PropTypes.func.isRequired,
  pasteToken: PropTypes.string.isRequired,
  onPasteTokenChange: PropTypes.func.isRequired,
  ideStatus: PropTypes.shape({ installed: PropTypes.bool, path: PropTypes.string }),
  onSelectBrowser: PropTypes.func.isRequired,
  onSelectPasteToken: PropTypes.func.isRequired,
  onSubmit: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
};
