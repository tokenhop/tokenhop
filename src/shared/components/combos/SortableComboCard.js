"use client";

import PropTypes from "prop-types";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import ComboListCard from "./ComboListCard";

/**
 * ComboListCard wrapped for @dnd-kit sorting. Drag the handle (or focus it
 * and use arrow keys) to reorder; the whole card stays a select button.
 */
export default function SortableComboCard({
  combo,
  index,
  total,
  strategy,
  strategyLabel,
  strategyVariant,
  usageToday,
  selected,
  onSelect,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: combo.id,
  });
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

  return (
    <li
      ref={setNodeRef}
      style={style}
      aria-label={`${combo.name}, position ${index + 1} of ${total}`}
      className={`relative rounded-2xl ${isDragging ? "shadow-card" : ""}`}
    >
      <ComboListCard
        combo={combo}
        strategy={strategy}
        strategyLabel={strategyLabel}
        strategyVariant={strategyVariant}
        usageToday={usageToday}
        selected={selected}
        onSelect={onSelect}
        className="ps-11"
      />
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${combo.name}`}
        className="absolute start-1.5 top-1/2 inline-flex size-8 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded-lg text-muted transition-colors hover:text-text focus-visible:shadow-focus focus-visible:outline-none active:cursor-grabbing"
      >
        <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
          drag_indicator
        </span>
      </button>
    </li>
  );
}

SortableComboCard.propTypes = {
  combo: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    models: PropTypes.arrayOf(PropTypes.string),
    kind: PropTypes.string,
  }).isRequired,
  index: PropTypes.number.isRequired,
  total: PropTypes.number.isRequired,
  strategy: PropTypes.string,
  strategyLabel: PropTypes.string,
  strategyVariant: PropTypes.string,
  usageToday: PropTypes.number,
  selected: PropTypes.bool,
  onSelect: PropTypes.func,
};
