"use client";

import PropTypes from "prop-types";
import {
  Button,
  Callout,
  CopyField,
  ProviderTile,
  StatusPill,
  Skeleton,
} from "@/shared/components";
import { getCooldownUntil } from "../utils";

/**
 * Signal provider detail identity: tile, connection count, auth/status pills,
 * sign-up link and model-id snippet. The shell owns the breadcrumb; this block owns the H1.
 */
export default function ProviderDetailHeader({
  providerId,
  providerInfo,
  connections,
  authLabel,
  authVariant,
  modelSnippet,
  loading,
}) {
  const activeCount = connections.filter((entry) => entry.isActive !== false).length;
  const cooldownCount = connections.filter((entry) => getCooldownUntil(entry)).length;
  const errorCount = connections.filter((entry) =>
    ["error", "expired"].includes(entry.testStatus),
  ).length;
  const status =
    connections.length === 0
      ? { variant: "neutral", label: "No accounts" }
      : errorCount > 0
        ? { variant: "err", label: `${errorCount} error${errorCount === 1 ? "" : "s"}` }
        : cooldownCount > 0
          ? { variant: "warn", label: `${cooldownCount} cooling down` }
          : { variant: "ok", label: `${activeCount} active` };
  const externalUrl =
    providerInfo?.notice?.apiKeyUrl || providerInfo?.notice?.signupUrl || providerInfo?.website;

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-start gap-3.5">
        <ProviderTile
          providerId={providerId}
          size="lg"
          status={status.variant === "neutral" ? undefined : status.variant}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h1 className="font-display text-2xl font-bold tracking-[-0.02em] text-text lg:text-[42px] lg:leading-[1.05]">
            {providerInfo?.name || providerId}
          </h1>
          <div className="flex flex-wrap items-center gap-1.5" aria-live="polite">
            <StatusPill variant={authVariant}>{authLabel}</StatusPill>
            <StatusPill variant={status.variant} dot={status.variant !== "neutral"}>
              {status.label}
            </StatusPill>
            {externalUrl ? (
              <a
                href={externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-1 px-1 text-xs font-semibold text-coral-ink hover:text-coral focus-visible:shadow-focus focus-visible:outline-none"
              >
                <span className="material-symbols-outlined text-sm" aria-hidden="true">
                  open_in_new
                </span>
                {providerInfo?.notice?.apiKeyUrl ? "Get API key" : "Sign up / Learn more"}
              </a>
            ) : null}
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-2 rounded-2xl bg-raised p-3.5">
        <span className="text-[13px] text-muted">
          Point any client at your endpoint and ask for
        </span>
        {loading ? (
          <Skeleton className="h-11 w-full" />
        ) : (
          <CopyField
            value={`"model": "${modelSnippet}"`}
            copyValue={modelSnippet}
            label="Copy model id snippet"
          />
        )}
      </div>
    </div>
  );
}

ProviderDetailHeader.propTypes = {
  providerId: PropTypes.string.isRequired,
  providerInfo: PropTypes.object,
  connections: PropTypes.array.isRequired,
  authLabel: PropTypes.string.isRequired,
  authVariant: PropTypes.string.isRequired,
  modelSnippet: PropTypes.string.isRequired,
  loading: PropTypes.bool,
};

/** Strips a leading warning glyph and redundant "Risk notice:" label; the Callout supplies both. */
export function plainNotice(text) {
  return String(text || "")
    .replace(/^\s*(?:\u26A0\uFE0F?\s*)?(?:risk notice:\s*)?/i, "")
    .trim();
}

export function ProviderDetailNotices({ providerInfo }) {
  if (providerInfo?.deprecated) {
    return (
      <Callout variant="warn" title="Risk notice">
        {plainNotice(providerInfo.deprecationNotice)}
      </Callout>
    );
  }
  if (providerInfo?.notice?.text) {
    return (
      <Callout variant="info" title="Provider notice" icon="info">
        <span className="flex flex-wrap items-center gap-2">
          {providerInfo.notice.text}
          {providerInfo.notice.apiKeyUrl ? (
            <Button
              size="sm"
              variant="secondary"
              iconRight="open_in_new"
              onClick={() => window.open(providerInfo.notice.apiKeyUrl, "_blank", "noopener")}
            >
              Get API key
            </Button>
          ) : null}
        </span>
      </Callout>
    );
  }
  return null;
}

ProviderDetailNotices.propTypes = { providerInfo: PropTypes.object };
