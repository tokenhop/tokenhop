"use client";

import PropTypes from "prop-types";
import { Button, Card, EmptyState, IconButton } from "@/shared/components";
import ProviderTile from "@/shared/components/ProviderTile";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { parseModelEntry } from "../mediaComboConfig";

function ProviderRow({ entry, idx, total, onMove, onRemove }) {
  const { providerId, model } = parseModelEntry(entry);
  const p = AI_PROVIDERS[providerId];
  return (
    <div className="flex items-center gap-3 rounded-lg bg-raised p-2">
      <span className="w-5 text-center font-mono text-xs text-muted">{idx + 1}</span>
      <ProviderTile providerId={providerId} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{p?.name || providerId}</div>
        {model && <code className="block truncate font-mono text-[10px] text-muted">{model}</code>}
      </div>
      <div className="flex items-center gap-0.5">
        <IconButton
          icon="arrow_upward"
          label={`Move ${model || providerId} up`}
          onClick={() => onMove(idx, -1)}
          disabled={idx === 0}
          className="size-8 border-0 bg-transparent p-1 text-muted hover:bg-raised hover:text-coral-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
        />
        <IconButton
          icon="arrow_downward"
          label={`Move ${model || providerId} down`}
          onClick={() => onMove(idx, 1)}
          disabled={idx === total - 1}
          className="size-8 border-0 bg-transparent p-1 text-muted hover:bg-raised hover:text-coral-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
        />
        <IconButton
          icon="close"
          label={`Remove ${model || providerId}`}
          onClick={() => onRemove(idx)}
          className="size-8 border-0 bg-transparent p-1 text-muted hover:bg-err-bg hover:text-err"
        />
      </div>
    </div>
  );
}

ProviderRow.propTypes = {
  entry: PropTypes.string.isRequired,
  idx: PropTypes.number.isRequired,
  total: PropTypes.number.isRequired,
  onMove: PropTypes.func.isRequired,
  onRemove: PropTypes.func.isRequired,
};

/** Ordered provider list with move/remove actions and the Add provider entry point. */
export default function ComboProvidersCard({ providers, roundRobin, onAdd, onMove, onRemove }) {
  return (
    <Card>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Providers</h2>
          <p className="text-xs text-muted">
            {roundRobin
              ? "Rotated across requests because round robin is on."
              : "Tried in order, top to bottom."}
          </p>
        </div>
        <Button size="sm" icon="add" onClick={onAdd}>
          Add provider
        </Button>
      </div>
      {providers.length === 0 ? (
        <EmptyState compact icon="layers" title="No providers yet." as="p" />
      ) : (
        <div className="flex flex-col gap-2">
          {providers.map((entry, idx) => (
            <ProviderRow
              // biome-ignore lint/suspicious/noArrayIndexKey: duplicate model ids repeat; position disambiguates.
              key={`${entry}-${idx}`}
              entry={entry}
              idx={idx}
              total={providers.length}
              onMove={onMove}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

ComboProvidersCard.propTypes = {
  providers: PropTypes.arrayOf(PropTypes.string).isRequired,
  roundRobin: PropTypes.bool.isRequired,
  onAdd: PropTypes.func.isRequired,
  onMove: PropTypes.func.isRequired,
  onRemove: PropTypes.func.isRequired,
};
