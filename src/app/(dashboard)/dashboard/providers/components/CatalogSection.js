"use client";

import PropTypes from "prop-types";
import { memo } from "react";
import ProviderCard from "./ProviderCard";

const APIKEY_INITIAL_VISIBLE = 20;

/**
 * Catalog card wrapper building the per-entry callbacks once, so list
 * re-renders skip cards whose props did not change.
 */
export const CatalogProviderCard = memo(function CatalogProviderCard({
  entry,
  connections,
  selected,
  modelCount,
  openProvider,
  handleToggleProvider,
}) {
  return (
    <ProviderCard
      entry={entry}
      connections={connections}
      selected={selected}
      modelCount={modelCount}
      onSelect={() => openProvider(entry)}
      onToggle={(active) => handleToggleProvider(entry.id, entry.authTypes, active)}
    />
  );
});

CatalogProviderCard.propTypes = {
  entry: PropTypes.object.isRequired,
  connections: PropTypes.array.isRequired,
  selected: PropTypes.bool,
  modelCount: PropTypes.number,
  openProvider: PropTypes.func.isRequired,
  handleToggleProvider: PropTypes.func.isRequired,
};

/**
 * One collapsible catalog group under "Add more providers". The heading is a
 * real disclosure button (44px target, mirrored chevron in RTL); search or an
 * active filter forces the group open regardless of the persisted state.
 *
 * @param {object} props
 * @param {object} props.section Catalog group with `catalogCount` (pre-filter, minus your providers).
 * @param {boolean} props.collapsed Persisted collapse state for this group.
 * @param {(id: string) => void} props.onToggleCollapse
 * @param {(entry: object) => object[]} props.connectionsFor
 * @param {boolean} props.showAllApikey
 * @param {(updater: (v: boolean) => boolean) => void} props.setShowAllApikey
 * @param {boolean} props.forceOpen Expand regardless of stored state (search/filter active).
 * @param {string} props.selectedProvider
 * @param {(entry: object) => number|null} props.modelCountFor
 * @param {(entry: object) => void} props.openProvider
 * @param {Function} props.handleToggleProvider
 */
function CatalogSection({
  section,
  collapsed,
  onToggleCollapse,
  connectionsFor,
  showAllApikey,
  setShowAllApikey,
  forceOpen,
  selectedProvider,
  modelCountFor,
  openProvider,
  handleToggleProvider,
}) {
  const open = forceOpen || !collapsed;
  const gridId = `providers-${section.id}-grid`;
  const entries =
    section.id === "apikey" && !showAllApikey && !forceOpen
      ? section.entries.slice(0, APIKEY_INITIAL_VISIBLE)
      : section.entries;

  return (
    <section aria-labelledby={`providers-${section.id}`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 id={`providers-${section.id}`} className="font-display text-lg font-bold lg:text-xl">
          <button
            type="button"
            onClick={() => onToggleCollapse(section.id)}
            aria-expanded={open}
            aria-controls={gridId}
            className="flex min-h-11 items-center gap-1.5 rounded-lg pe-1 text-start focus-visible:outline-none focus-visible:shadow-focus"
          >
            <span
              className={`material-symbols-outlined text-[20px] transition-transform motion-reduce:transition-none ${
                open ? "" : "-rotate-90 rtl:rotate-90"
              }`}
              aria-hidden="true"
            >
              expand_more
            </span>
            {section.title}
            <span className="text-[13px] font-normal text-muted">{section.catalogCount}</span>
          </button>
        </h3>
        <span className="text-[13px] text-muted">{section.subtitle}</span>
        {section.id === "apikey" && section.catalogCount > APIKEY_INITIAL_VISIBLE && (
          <button
            type="button"
            onClick={() => setShowAllApikey((v) => !v)}
            aria-expanded={showAllApikey || forceOpen}
            className="ms-auto inline-flex min-h-11 items-center px-1 text-[13px] font-semibold text-coral-ink hover:text-coral focus-visible:outline-none focus-visible:shadow-focus"
          >
            {showAllApikey || forceOpen ? "Show less" : `Show all ${section.catalogCount} →`}
          </button>
        )}
      </div>
      <div id={gridId} className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
        {open &&
          entries.map((entry) => (
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
    </section>
  );
}

CatalogSection.propTypes = {
  section: PropTypes.object.isRequired,
  collapsed: PropTypes.bool.isRequired,
  onToggleCollapse: PropTypes.func.isRequired,
  connectionsFor: PropTypes.func.isRequired,
  showAllApikey: PropTypes.bool.isRequired,
  setShowAllApikey: PropTypes.func.isRequired,
  forceOpen: PropTypes.bool,
  selectedProvider: PropTypes.string,
  modelCountFor: PropTypes.func.isRequired,
  openProvider: PropTypes.func.isRequired,
  handleToggleProvider: PropTypes.func.isRequired,
};

export default memo(CatalogSection);
