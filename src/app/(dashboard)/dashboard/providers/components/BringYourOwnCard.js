"use client";

import PropTypes from "prop-types";
import { memo } from "react";
import { Button } from "@/shared/components";
import { CatalogProviderCard } from "./CatalogSection";

/**
 * Merged "Bring your own endpoint" card. Always shows both compatible-endpoint
 * actions; any unconnected custom provider nodes render as a ProviderCard
 * grid under the description. The only place where custom entries appear.
 *
 * @param {object} props
 * @param {object[]} props.entries Unconnected custom catalog entries.
 * @param {(entry: object) => object[]} props.connectionsFor
 * @param {string} props.selectedProvider
 * @param {(entry: object) => number|null} props.modelCountFor
 * @param {(entry: object) => void} props.openProvider
 * @param {Function} props.handleToggleProvider
 * @param {() => void} props.onAddOpenAI
 * @param {() => void} props.onAddAnthropic
 */
function BringYourOwnCard({
  entries,
  connectionsFor,
  selectedProvider,
  modelCountFor,
  openProvider,
  handleToggleProvider,
  onAddOpenAI,
  onAddAnthropic,
}) {
  return (
    <section
      aria-label="Bring your own endpoint"
      className="flex flex-col gap-3 rounded-2xl border border-dashed border-line p-4 sm:px-4.5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-3.5">
        <span className="material-symbols-outlined text-[22px] text-muted" aria-hidden="true">
          code
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-semibold">Bring your own endpoint</span>
          <span className="text-[13px] text-muted">
            Any OpenAI- or Anthropic-compatible base URL becomes a provider.
          </span>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button size="sm" variant="secondary" onClick={onAddOpenAI}>
            + OpenAI compatible
          </Button>
          <Button size="sm" variant="secondary" onClick={onAddAnthropic}>
            + Anthropic compatible
          </Button>
        </div>
      </div>
      {entries.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
          {entries.map((entry) => (
            <CatalogProviderCard
              key={entry.id}
              entry={entry}
              connections={connectionsFor(entry)}
              selected={selectedProvider === entry.id}
              modelCount={modelCountFor(entry)}
              openProvider={openProvider}
              handleToggleProvider={handleToggleProvider}
            />
          ))}
        </div>
      )}
    </section>
  );
}

BringYourOwnCard.propTypes = {
  entries: PropTypes.array.isRequired,
  connectionsFor: PropTypes.func.isRequired,
  selectedProvider: PropTypes.string,
  modelCountFor: PropTypes.func.isRequired,
  openProvider: PropTypes.func.isRequired,
  handleToggleProvider: PropTypes.func.isRequired,
  onAddOpenAI: PropTypes.func.isRequired,
  onAddAnthropic: PropTypes.func.isRequired,
};

export default memo(BringYourOwnCard);
