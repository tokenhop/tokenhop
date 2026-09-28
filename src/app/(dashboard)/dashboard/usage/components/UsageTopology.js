"use client";

import PropTypes from "prop-types";
import dynamic from "next/dynamic";
import Card from "@/shared/components/Card";

const ProviderTopology = dynamic(() => import("./ProviderTopology"), { ssr: false });

/**
 * Thin Signal wrapper keeping ProviderTopology as-is. Decision: the Home
 * live-routes panel (YAN-293) is not merged, so this xyflow topology is
 * still the only live-route view — restyle only the container as a Card.
 * A visually-hidden list mirrors provider states for screen readers.
 *
 * @param {object} props
 * @param {Array<object>} [props.providers]
 * @param {Array<object>} [props.activeRequests]
 * @param {string} [props.lastProvider]
 * @param {string} [props.errorProvider]
 */
export default function UsageTopology({
  providers = [],
  activeRequests = [],
  lastProvider = "",
  errorProvider = "",
}) {
  const active = new Set((activeRequests || []).map((r) => r.provider?.toLowerCase()));
  return (
    <Card padding="sm" title="Live routes (per provider)">
      <div className="min-w-0">
        <ProviderTopology
          providers={providers}
          activeRequests={activeRequests}
          lastProvider={lastProvider}
          errorProvider={errorProvider}
        />
      </div>
      <ul className="sr-only">
        {providers.map((p) => (
          <li key={p.provider}>
            {p.name || p.provider}:{" "}
            {active.has(p.provider?.toLowerCase())
              ? "active"
              : (errorProvider || "").toLowerCase() === p.provider?.toLowerCase()
                ? "error"
                : (lastProvider || "").toLowerCase() === p.provider?.toLowerCase()
                  ? "last used"
                  : "idle"}
          </li>
        ))}
      </ul>
    </Card>
  );
}

UsageTopology.propTypes = {
  providers: PropTypes.array,
  activeRequests: PropTypes.array,
  lastProvider: PropTypes.string,
  errorProvider: PropTypes.string,
};
