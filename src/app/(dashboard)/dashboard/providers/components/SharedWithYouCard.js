"use client";

import PropTypes from "prop-types";
import { Callout, Card, ModelChip, StatusPill } from "@/shared/components";
import { LoadingState } from "@/shared/components/StateViews";

/**
 * "Shared with you" card (YAN-376): read-only incoming grants. Rows are grant
 * metadata only — provider, connection name, allowed models — never secrets,
 * owner identity or emails. The caller mounts it only while multi-user is
 * active; with no grants it renders nothing.
 */
export default function SharedWithYouCard({ grants, loading, error }) {
  if (loading) return <LoadingState lines={2} label="Loading shared connections" />;
  if (error) {
    return (
      <Callout variant="err" title="Could not load shared connections">
        {error}
      </Callout>
    );
  }
  if (!grants || grants.length === 0) return null;
  return (
    <Card title="Shared with you" icon="group">
      <ul className="flex flex-col gap-2">
        {grants.map((grant) => (
          <li
            key={grant.grantId}
            className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-line bg-raised px-3 py-2.5"
          >
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">
              {grant.name}
            </span>
            <StatusPill variant="info" size="sm">
              {grant.provider}
            </StatusPill>
            {Array.isArray(grant.allowedModels) && grant.allowedModels.length > 0 ? (
              <span className="flex max-w-full flex-wrap gap-1" dir="ltr">
                {grant.allowedModels.slice(0, 4).map((model) => (
                  <ModelChip key={model} model={model} />
                ))}
                {grant.allowedModels.length > 4 && (
                  <span className="font-mono text-xs text-muted">
                    +{grant.allowedModels.length - 4} more
                  </span>
                )}
              </span>
            ) : (
              <StatusPill variant="neutral" size="sm">
                All models
              </StatusPill>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted">
        Use an API key in this workspace to route through a shared connection. The shared secret is
        never shown.
      </p>
    </Card>
  );
}

SharedWithYouCard.propTypes = {
  grants: PropTypes.array,
  loading: PropTypes.bool,
  error: PropTypes.string,
};
