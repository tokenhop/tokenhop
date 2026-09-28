"use client";

import { useRef } from "react";
import PropTypes from "prop-types";
import Callout from "@/shared/components/Callout";
import { STRATEGIES, STRATEGY_EXPLAINERS } from "./comboBuilder";

/**
 * Strategy picker: APG radio group with roving tabindex and Arrow/Home/End
 * keys (RTL-aware), plus the plain-language explainer callout. Mirrors
 * board copy verbatim.
 */
export default function StrategyPicker({ value, onChange }) {
  const refs = useRef([]);
  const active = Math.max(
    0,
    STRATEGIES.findIndex((s) => s.id === value),
  );
  const onKeyDown = (event, index) => {
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const rtl = event.currentTarget.closest("[dir]")?.getAttribute("dir") === "rtl";
    let next = index;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = STRATEGIES.length - 1;
    else {
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      const delta = (forward ? 1 : -1) * (rtl ? -1 : 1);
      next = (index + delta + STRATEGIES.length) % STRATEGIES.length;
    }
    refs.current[next]?.focus();
    onChange?.(STRATEGIES[next].id);
  };
  return (
    <div className="flex flex-col gap-3">
      <p
        id="combo-strategy-label"
        className="text-xs font-semibold tracking-wider text-muted uppercase"
      >
        How should these models take turns?
      </p>
      <div
        role="radiogroup"
        aria-labelledby="combo-strategy-label"
        className="grid grid-cols-2 gap-3 xl:grid-cols-4"
      >
        {STRATEGIES.map((s, index) => {
          const on = value === s.id;
          return (
            // biome-ignore lint/a11y/useSemanticElements: APG radio group; native radios cannot carry the strategy-card visual contract.
            <button
              key={s.id}
              ref={(element) => {
                refs.current[index] = element;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={index === active ? 0 : -1}
              onKeyDown={(event) => onKeyDown(event, index)}
              onClick={() => onChange?.(s.id)}
              className={`flex min-h-[108px] flex-col items-start gap-1.5 rounded-xl border bg-raised p-3.5 text-start transition-colors focus-visible:shadow-focus focus-visible:outline-none ${
                on ? "border-coral bg-coral-bg" : "border-line hover:border-subtle"
              }`}
            >
              <span
                className="material-symbols-outlined text-[22px] text-coral-ink"
                aria-hidden="true"
              >
                {s.icon}
              </span>
              <span className="text-[15px] font-bold text-text">{s.label}</span>
              <span className="text-xs leading-snug text-muted">{s.desc}</span>
            </button>
          );
        })}
      </div>
      <Callout variant="info" icon="info">
        {STRATEGY_EXPLAINERS[value] ?? STRATEGY_EXPLAINERS.fallback}
      </Callout>
    </div>
  );
}

StrategyPicker.propTypes = {
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func,
};
