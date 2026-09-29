"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { getDefaultPricing } from "open-sse/providers/pricing.js";
import Modal, { ConfirmDialog } from "./Modal";
import Button from "./Button";
import ProviderTile from "@/shared/components/ProviderTile";
import { LoadingState } from "./StateViews";
import { TABLE_HEAD_CELL, TABLE_HEAD_ROW } from "./displayPrimitives";

const PRICING_FIELDS = ["input", "output", "cached", "reasoning", "cache_creation"];
const FIELD_LABELS = {
  input: "Input",
  output: "Output",
  cached: "Cached",
  reasoning: "Reasoning",
  cache_creation: "Cache creation",
};

/**
 * Per-model pricing editor ($/1M tokens). Loads `/api/pricing` on open
 * (defaults on failure), saves with PATCH and resets with DELETE after a
 * confirmation. Save and reset failures are shown inline.
 *
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {() => void} [props.onSave] Called after a successful save, before close.
 */
export default function PricingModal({ isOpen, onClose, onSave }) {
  const [pricingData, setPricingData] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    setLoading(true);
    setError("");
    fetch("/api/pricing")
      .then(async (response) => (response.ok ? response.json() : getDefaultPricing()))
      .catch((err) => {
        console.error("Failed to load pricing:", err);
        return getDefaultPricing();
      })
      .then((data) => {
        if (alive) setPricingData(data);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [isOpen]);

  const handlePricingChange = (provider, model, field, value) => {
    const numValue = Number.parseFloat(value);
    if (Number.isNaN(numValue) || numValue < 0) return;
    setPricingData((prev) => ({
      ...prev,
      [provider]: {
        ...prev[provider],
        [model]: { ...prev[provider]?.[model], [field]: numValue },
      },
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/pricing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pricingData),
      });
      if (response.ok) {
        onSave?.();
        onClose();
      } else {
        const body = await response.json().catch(() => ({}));
        setError(`Failed to save pricing: ${body.error || response.status}`);
      }
    } catch (err) {
      console.error("Failed to save pricing:", err);
      setError("Failed to save pricing");
    } finally {
      setSaving(false);
    }
  };

  // Rejects keep the confirm dialog open with the error shown inside it.
  const handleReset = async () => {
    const response = await fetch("/api/pricing", { method: "DELETE" });
    if (!response.ok) throw new Error("Failed to reset pricing");
    setPricingData(getDefaultPricing());
    setConfirmReset(false);
  };

  const providers = Object.keys(pricingData).sort();

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Pricing Configuration"
        size="full"
        className="max-w-6xl"
        closeOnOverlay={!saving}
        closeOnEscape={!saving && !confirmReset}
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <Button variant="danger" onClick={() => setConfirmReset(true)} disabled={saving}>
              Reset to defaults
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={handleSave} loading={saving} disabled={loading}>
                {saving ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </div>
        }
      >
        <div aria-live="polite">
          {error && (
            <p role="alert" className="mb-4 rounded-lg bg-err-bg px-3 py-2 text-sm text-err">
              {error}
            </p>
          )}
        </div>
        {loading ? (
          <LoadingState label="Loading pricing" lines={4} />
        ) : (
          <div className="space-y-6">
            <div className="rounded-lg border border-line bg-raised p-3 text-sm">
              <p className="mb-1 font-medium text-text">Pricing rates format</p>
              <p className="text-muted">
                All rates are in <strong>dollars per million tokens</strong> ($/1M tokens). Example:
                Input rate of 2.50 means $2.50 per 1,000,000 input tokens.
              </p>
            </div>
            {providers.map((provider) => (
              <ProviderPricingTable
                key={provider}
                provider={provider}
                models={pricingData[provider]}
                onChange={handlePricingChange}
              />
            ))}
            {providers.length === 0 && (
              <div className="py-8 text-center text-muted">No pricing data available</div>
            )}
          </div>
        )}
      </Modal>
      <ConfirmDialog
        isOpen={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={handleReset}
        title="Reset pricing"
        message="Reset all pricing to defaults? This cannot be undone."
        confirmText="Reset to defaults"
      />
    </>
  );
}

PricingModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSave: PropTypes.func,
};

function ProviderPricingTable({ provider, models, onChange }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-2 bg-raised px-4 py-2 text-sm font-semibold text-text">
        <ProviderTile providerId={provider} size="sm" />
        {provider.toUpperCase()}
      </div>
      <section
        className="overflow-x-auto focus-visible:shadow-focus"
        aria-label="Pricing table"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable table region is keyboard-focusable with a label (WCAG 2.1.1, YAN-314).
        tabIndex={0}
      >
        <table className="w-full text-sm">
          <thead>
            <tr className={TABLE_HEAD_ROW}>
              <th scope="col" className={`${TABLE_HEAD_CELL} px-3 py-2 text-start`}>
                Model
              </th>
              {PRICING_FIELDS.map((field) => (
                <th key={field} scope="col" className={`${TABLE_HEAD_CELL} px-3 py-2 text-end`}>
                  {FIELD_LABELS[field]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {Object.keys(models)
              .sort()
              .map((model) => (
                <tr key={model} className="hover:bg-raised/60">
                  <td className="px-3 py-2 font-medium text-text">{model}</td>
                  {PRICING_FIELDS.map((field) => (
                    <td key={field} className="px-3 py-2">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        aria-label={`${model} ${FIELD_LABELS[field]}`}
                        value={models[model][field] || 0}
                        onChange={(event) => onChange(provider, model, field, event.target.value)}
                        className="w-20 rounded border border-line bg-raised px-2 py-1 text-end text-text focus:border-coral focus:shadow-focus focus:outline-none"
                      />
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

ProviderPricingTable.propTypes = {
  provider: PropTypes.string.isRequired,
  models: PropTypes.object.isRequired,
  onChange: PropTypes.func.isRequired,
};
