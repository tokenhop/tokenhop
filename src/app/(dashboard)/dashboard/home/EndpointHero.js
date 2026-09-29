"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Button from "@/shared/components/Button";
import Callout from "@/shared/components/Callout";
import Card from "@/shared/components/Card";
import CardLink from "@/shared/components/CardLink";
import CopyField from "@/shared/components/CopyField";
import StatusPill from "@/shared/components/StatusPill";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import CopyStatus from "@/shared/components/CopyStatus";
import { WidgetEmpty, WidgetError, WidgetSkeleton } from "./WidgetStates";

/**
 * Ways-in state for the endpoint hero, derived from /api/tunnel/status + settings.
 * @param {object} tunnel
 * @returns {{ items: Array<{ id: string, label: string, value: string|null, status: "ok"|"off"|"warn" }>, tunnelOn: boolean, tunnelUrl: string }}
 */
export function deriveWaysIn(tunnel) {
  const cf = tunnel?.tunnel ?? {};
  const ts = tunnel?.tailscale ?? {};
  const tunnelOn = Boolean(cf.settingsEnabled ?? cf.enabled);
  const tunnelUrl = cf.publicUrl || cf.tunnelUrl || "";
  const tsOn = Boolean(ts.settingsEnabled ?? ts.enabled);
  return {
    tunnelOn,
    tunnelUrl,
    items: [
      { id: "local", label: "Local", value: "127.0.0.1", status: "ok" },
      {
        id: "tailscale",
        label: "Tailscale",
        value: tsOn ? ts.tunnelUrl || "Connected" : null,
        status: tsOn ? "ok" : "off",
      },
      {
        id: "cloudflare",
        label: "Cloudflare tunnel",
        value: tunnelOn ? tunnelUrl || "On" : null,
        status: tunnelOn ? "ok" : "off",
      },
    ],
  };
}

/**
 * Endpoint hero: real /v1 URL + primary Copy, Local/Tailscale/Cloudflare chips
 * (Enable reuses POST /api/tunnel/enable), API-key gate, link to Endpoint & keys.
 *
 * @param {object} props
 * @param {string} props.origin browser origin (the real host the page runs on)
 * @param {object} props.tunnel result of useHomeWaysIn
 * @param {boolean} props.loading
 * @param {string|null} props.error
 * @param {() => void} props.onRetry
 * @param {() => void} props.onChanged bump the parent refresh key after enable
 */
export default function EndpointHero({ origin, tunnel, loading, error, onRetry, onChanged }) {
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState(null);
  const { copied, error: copyError, copy } = useCopyToClipboard();

  if (loading) return <WidgetSkeleton lines={3} label="Loading endpoint" />;
  if (error) return <WidgetError message={error} onRetry={onRetry} />;

  const endpoint = `${origin || ""}/v1`;
  const { items, tunnelOn, tunnelUrl } = deriveWaysIn(tunnel);
  const requireApiKey = Boolean(tunnel?.requireApiKey);

  const enableTunnel = async () => {
    setEnabling(true);
    setEnableError(null);
    try {
      const response = await fetch("/api/tunnel/enable", { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "Could not start the tunnel");
      onChanged?.();
    } catch (err) {
      setEnableError(err.message || "Could not start the tunnel");
    } finally {
      setEnabling(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold tracking-[0.08em] text-muted uppercase">
          Your endpoint
        </span>
        <StatusPill variant="ok" dot>
          OpenAI-compatible
        </StatusPill>
        <span className="ms-auto shrink-0">
          <CardLink href="/dashboard/endpoint" showArrow={false}>
            Endpoint settings
          </CardLink>
        </span>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          {/* The lime Copy button is the one copy control for this value. */}
          <CopyField value={endpoint} showCopyButton={false} className="border-dashed" />
        </div>
        <Button
          variant="primary"
          icon="content_copy"
          onClick={() => copy(endpoint, "endpoint")}
          className="sm:min-h-[60px] sm:px-6 sm:text-[15px]"
        >
          {copied === "endpoint" ? "Copied" : copyError === "endpoint" ? "Couldn't copy" : "Copy"}
        </Button>
        <CopyStatus copied={copied} error={copyError} id="endpoint" />
      </div>

      <ul className="flex flex-wrap gap-2.5" aria-label="Ways to reach your endpoint">
        {items.map((item) => (
          <li
            key={item.id}
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line bg-raised px-3 text-[13px] font-medium text-text"
          >
            <span
              aria-hidden="true"
              className={`size-2 shrink-0 rounded-full ${item.status === "ok" ? "bg-ok" : "bg-subtle"}`}
            />
            {item.label}
            {item.id === "cloudflare" && !tunnelOn ? (
              <Button variant="outline" size="sm" loading={enabling} onClick={enableTunnel}>
                Enable
              </Button>
            ) : (
              item.value && (
                <span className="max-w-48 truncate font-mono text-xs text-muted">{item.value}</span>
              )
            )}
          </li>
        ))}
        <li className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line bg-raised px-3 text-[13px] font-medium text-text">
          <span className="material-symbols-outlined text-[16px] text-ok" aria-hidden="true">
            {requireApiKey ? "verified_user" : "lock_open"}
          </span>
          {requireApiKey ? "API key required" : "API key not required"}
        </li>
      </ul>

      {tunnelOn && tunnelUrl ? (
        <p className="truncate font-mono text-xs text-muted">
          Tunnel live at <span className="text-text">{tunnelUrl}</span>
        </p>
      ) : null}
      {enableError ? <Callout variant="err">{enableError}</Callout> : null}
    </div>
  );
}

EndpointHero.propTypes = {
  origin: PropTypes.string,
  tunnel: PropTypes.object,
  loading: PropTypes.bool,
  error: PropTypes.string,
  onRetry: PropTypes.func.isRequired,
  onChanged: PropTypes.func,
};

/** Card wrapper so the page grid stays dumb. */
export function EndpointHeroCard(props) {
  const empty = !props.loading && !props.error && !props.origin;
  return (
    <Card className="min-w-0 lg:col-span-2">
      {empty ? (
        <WidgetEmpty
          icon="api"
          title="Endpoint is starting"
          body="Open this page from the running dashboard to see the real endpoint URL."
          actionLabel="Open Endpoint settings"
          actionHref="/dashboard/endpoint"
        />
      ) : (
        <EndpointHero {...props} />
      )}
    </Card>
  );
}

EndpointHeroCard.propTypes = {
  ...EndpointHero.propTypes,
};
