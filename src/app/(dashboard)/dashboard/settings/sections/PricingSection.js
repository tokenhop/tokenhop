"use client";

import PropTypes from "prop-types";
import { useEffect, useRef, useState } from "react";
import SectionCard from "@/shared/components/SectionCard";
import StatTile from "@/shared/components/StatTile";
import Button from "@/shared/components/Button";
import PricingModal from "@/shared/components/PricingModal";
import { Skeleton } from "@/shared/components/Loading";
import EmptyState from "@/shared/components/EmptyState";
import ProviderTile from "@/shared/components/ProviderTile";

/**
 * Pricing section: overview table + edit modal + reset to defaults.
 * Data comes from GET /api/pricing; edits save via the shared PricingModal.
 */
export default function PricingSection({ modalOpen, onModalChange }) {
  const [pricing, setPricing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [internalModalOpen, setInternalModalOpen] = useState(false);
  const showModal = modalOpen !== undefined ? modalOpen : internalModalOpen;
  const setShowModal = onModalChange || setInternalModalOpen;
  const abortRef = useRef(null);

  const loadPricing = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/pricing", { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPricing(data);
    } catch (err) {
      if (err?.name === "AbortError") return;
      setError("Failed to load pricing data");
    } finally {
      if (abortRef.current === controller) setLoading(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load-once on mount by design.
  useEffect(() => {
    loadPricing();
    return () => abortRef.current?.abort();
  }, []);

  const providers = pricing ? Object.keys(pricing).sort() : [];
  const modelCount = providers.reduce(
    (sum, provider) => sum + Object.keys(pricing[provider] || {}).length,
    0,
  );
  const customCount = providers.reduce(
    (sum, provider) =>
      sum +
      Object.values(pricing[provider] || {}).filter((entry) => entry && entry.custom === true)
        .length,
    0,
  );

  return (
    <div id="pricing" className="scroll-mt-24 space-y-4">
      <SectionCard
        icon="savings"
        title="Pricing"
        subtitle="What cost estimates use, in $ per 1M tokens."
      />
      <div className="rounded-2xl border border-line bg-panel p-5 shadow-card space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatTile eyebrow="Models" value={loading ? "…" : String(modelCount)} />
          <StatTile eyebrow="Providers" value={loading ? "…" : String(providers.length)} />
          <StatTile eyebrow="Custom" value={loading ? "…" : String(customCount)} />
        </div>

        {loading ? (
          <Skeleton />
        ) : error ? (
          <EmptyState
            icon="error"
            title="Could not load pricing"
            body={error}
            action={
              <Button variant="secondary" onClick={loadPricing}>
                Retry
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[42rem] text-sm">
              <thead>
                <tr className="text-start text-xs text-muted">
                  <th className="px-3 py-2 text-start font-semibold">Model</th>
                  <th className="px-3 py-2 text-end font-semibold">Input</th>
                  <th className="px-3 py-2 text-end font-semibold">Output</th>
                  <th className="px-3 py-2 text-end font-semibold">Cached</th>
                </tr>
              </thead>
              <tbody>
                {providers.slice(0, 5).flatMap((provider) =>
                  Object.keys(pricing[provider] || {})
                    .slice(0, 10)
                    .map((model) => {
                      const entry = pricing[provider][model] || {};
                      return (
                        <tr key={`${provider}/${model}`} className="border-t border-line">
                          <td className="px-3 py-2 font-mono text-xs text-text">
                            <ProviderTile
                              providerId={provider}
                              size="sm"
                              className="me-2 align-middle"
                            />
                            {provider}/{model}
                            {entry.custom === true && (
                              <span className="ms-1.5 rounded-full bg-coral-bg px-1.5 py-0.5 text-[10px] font-semibold text-coral-ink">
                                Custom
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-end tabular-nums text-text">
                            {entry.input ?? "—"}
                          </td>
                          <td className="px-3 py-2 text-end tabular-nums text-text">
                            {entry.output ?? "—"}
                          </td>
                          <td className="px-3 py-2 text-end tabular-nums text-text">
                            {entry.cached ?? "—"}
                          </td>
                        </tr>
                      );
                    }),
                )}
              </tbody>
            </table>
            {providers.length > 5 && (
              <p className="border-t border-line px-3 py-2 text-xs text-muted">
                + {providers.length - 5} more providers — open Edit pricing for full details.
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon="edit" onClick={() => setShowModal(true)}>
            Edit pricing
          </Button>
          <Button variant="ghost" icon="restart_alt" onClick={() => setShowModal(true)}>
            Reset to defaults…
          </Button>
        </div>
      </div>

      <PricingModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        onSave={() => loadPricing()}
      />
    </div>
  );
}

PricingSection.propTypes = {
  modalOpen: PropTypes.bool,
  onModalChange: PropTypes.func,
};
