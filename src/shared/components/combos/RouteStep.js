"use client";

import PropTypes from "prop-types";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import IconButton from "@/shared/components/IconButton";
import Meter from "@/shared/components/Meter";
import ProviderTile from "@/shared/components/ProviderTile";
import StatusPill from "@/shared/components/StatusPill";
import { isFallbackOnly } from "./comboBuilder";

/** One numbered route step: bubble, ProviderTile, health pill, drag handle, remove, weight row. */
export default function RouteStep({
  uid,
  index,
  model,
  providerLabel,
  role,
  health,
  healthVariant,
  showWeight,
  weight,
  share,
  weightError,
  onWeightChange,
  onWeightBlur,
  onRemove,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: uid,
  });
  // Reduced motion: skip the dnd-kit settle transition, keep the reorder instant.
  const reducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: reducedMotion ? undefined : transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  const providerId = model.includes("/") ? model.slice(0, model.indexOf("/")) : model;
  return (
    <li style={style} ref={setNodeRef} className="flex list-none gap-3.5">
      <div className="flex w-8 shrink-0 flex-col items-center" aria-hidden="true">
        <span className="flex size-8 items-center justify-center rounded-full bg-text font-mono text-[13px] font-semibold text-bg">
          {index + 1}
        </span>
        <span className="my-1.5 w-0.5 flex-1 bg-[repeating-linear-gradient(var(--signal-subtle)_0_5px,transparent_5px_11px)]" />
      </div>
      <div
        className={`mb-3 flex min-w-0 flex-1 flex-col gap-3 rounded-xl border border-line bg-raised p-3.5 sm:p-4 ${
          isDragging ? "border-coral shadow-card" : ""
        }`}
      >
        <div className="flex min-w-0 items-center gap-3">
          <ProviderTile providerId={providerId} size="md" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-[15px] font-medium text-text">{model}</p>
            <p className="truncate text-xs text-muted">
              {providerLabel} · {role}
            </p>
          </div>
          <StatusPill variant={healthVariant} size="sm">
            {health}
          </StatusPill>
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${model}, position ${index + 1}`}
            title="Drag to reorder"
            className="inline-flex size-10 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-muted transition-colors hover:text-text focus-visible:shadow-focus focus-visible:outline-none active:cursor-grabbing"
          >
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              drag_indicator
            </span>
          </button>
          <IconButton icon="close" label={`Remove ${model} from route`} onClick={onRemove} />
        </div>
        {showWeight && (
          <div className="flex items-center gap-3 ps-12">
            <label htmlFor={`${uid}-weight`} className="shrink-0 text-xs text-muted">
              Weight
            </label>
            <input
              id={`${uid}-weight`}
              type="number"
              min="0"
              max="1000"
              step="1"
              value={weight}
              aria-invalid={weightError ? true : undefined}
              aria-describedby={weightError ? `${uid}-weight-error` : undefined}
              onChange={(e) => onWeightChange?.(e.target.value)}
              onBlur={() => onWeightBlur?.()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
              className="h-8 w-20 shrink-0 rounded-lg border border-line bg-panel px-2 text-center font-mono text-[13px] text-text outline-none focus:border-coral focus:shadow-focus"
            />
            <Meter
              value={share}
              label={`Traffic share for ${model}`}
              valueText={
                isFallbackOnly(Number(weight)) && weight !== ""
                  ? "Fallback only"
                  : `about ${share} percent`
              }
              className="min-w-0 flex-1"
            />
            <span className="w-20 shrink-0 text-end font-mono text-xs text-muted">
              {isFallbackOnly(Number(weight)) && weight !== "" ? "Fallback only" : `≈${share}%`}
            </span>
            {weightError && (
              <span id={`${uid}-weight-error`} role="alert" className="w-full text-xs text-err">
                {weightError}
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

RouteStep.propTypes = {
  uid: PropTypes.string.isRequired,
  index: PropTypes.number.isRequired,
  model: PropTypes.string.isRequired,
  providerLabel: PropTypes.string.isRequired,
  role: PropTypes.string.isRequired,
  health: PropTypes.string.isRequired,
  healthVariant: PropTypes.string.isRequired,
  showWeight: PropTypes.bool,
  weight: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  share: PropTypes.number,
  weightError: PropTypes.string,
  onWeightChange: PropTypes.func,
  onWeightBlur: PropTypes.func,
  onRemove: PropTypes.func,
};
