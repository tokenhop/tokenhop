"use client";

import PropTypes from "prop-types";
import { useEffect, useMemo, useState } from "react";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";
import CustomRangePicker from "@/shared/components/CustomRangePicker";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { cn } from "@/shared/utils/cn";
import { isCustomPeriod, PERIOD_VALUES, PERIODS } from "@/shared/utils/period";

/** zh labels per period value (runtime i18n parity on every page). */
const ZH_LABELS = {
  today: "今天",
  "24h": "24小时",
  "7d": "7天",
  "30d": "30天",
  "60d": "60天",
  "90d": "90天",
  all: "全部时间",
};

/**
 * Shared period radio group over SegmentedControl. zh locales relabel the
 * options after mount (initial render is English, so SSR markup is stable).
 * A `null` value renders the control with no selection.
 *
 * Passing `onRangeChange` adds a separate "Custom" range trigger after the
 * segments (Usage only). While `value` is "custom" the segments show no
 * selection and the trigger shows the active range instead.
 *
 * @param {object} props
 * @param {string|null} [props.value] Selected period value.
 * @param {(value: string) => void} [props.onChange]
 * @param {Array<{value: string, label: string}>} [props.options] Defaults to every period.
 * @param {"sm"|"md"|"lg"} [props.size="md"]
 * @param {string} [props.className]
 * @param {string} [props["aria-label"]="Period"]
 * @param {{from: string, to: string}|null} [props.range] Active custom range.
 * @param {(from: string, to: string) => boolean} [props.onRangeChange] Enables the custom range trigger.
 */
export default function PeriodControl({
  value,
  onChange,
  options = PERIODS,
  size = "md",
  className,
  "aria-label": ariaLabel = "Period",
  range = null,
  onRangeChange,
}) {
  const [locale, setLocale] = useState(null);

  // HomeHeader moved its zh label effect here so every page gets the override.
  useEffect(() => {
    setLocale(getCurrentLocale());
    return onLocaleChange(() => setLocale(getCurrentLocale()));
  }, []);

  const labeledOptions = useMemo(
    () =>
      locale?.startsWith("zh")
        ? options.map((option) => ({
            ...option,
            label: ZH_LABELS[option.value] ?? option.label,
          }))
        : options,
    [locale, options],
  );

  if (!onRangeChange) {
    return (
      <SegmentedControl
        options={labeledOptions}
        value={value}
        onChange={onChange}
        size={size}
        className={className}
        aria-label={ariaLabel}
      />
    );
  }

  const custom = isCustomPeriod(value);
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <SegmentedControl
        options={labeledOptions}
        value={custom ? null : value}
        onChange={onChange}
        size={size}
        className="min-w-0 flex-1 sm:flex-none"
        aria-label={ariaLabel}
      />
      <CustomRangePicker range={custom ? range : null} onApply={onRangeChange} />
    </div>
  );
}

PeriodControl.propTypes = {
  value: PropTypes.string,
  onChange: PropTypes.func,
  options: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.oneOf(PERIOD_VALUES).isRequired,
      label: PropTypes.string.isRequired,
    }),
  ),
  size: PropTypes.oneOf(["sm", "md", "lg"]),
  className: PropTypes.string,
  "aria-label": PropTypes.string,
  range: PropTypes.shape({
    from: PropTypes.string.isRequired,
    to: PropTypes.string.isRequired,
  }),
  onRangeChange: PropTypes.func,
};
