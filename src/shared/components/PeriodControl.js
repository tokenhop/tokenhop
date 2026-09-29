"use client";

import PropTypes from "prop-types";
import { useEffect, useMemo, useState } from "react";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { PERIODS } from "@/shared/utils/period";

/** zh labels per period value (runtime i18n parity on every page). */
const ZH_LABELS = {
  today: "今天",
  "24h": "24小时",
  "7d": "7天",
  "30d": "30天",
  "60d": "60天",
};

/**
 * Shared period radio group over SegmentedControl. zh locales relabel the
 * options after mount (initial render is English, so SSR markup is stable).
 * A `null` value renders the control with no selection.
 *
 * @param {object} props
 * @param {string|null} [props.value] Selected period value.
 * @param {(value: string) => void} [props.onChange]
 * @param {Array<{value: string, label: string}>} [props.options] Defaults to every period.
 * @param {"sm"|"md"|"lg"} [props.size="md"]
 * @param {string} [props.className]
 * @param {string} [props["aria-label"]="Period"]
 */
export default function PeriodControl({
  value,
  onChange,
  options = PERIODS,
  size = "md",
  className,
  "aria-label": ariaLabel = "Period",
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

PeriodControl.propTypes = {
  value: PropTypes.string,
  onChange: PropTypes.func,
  options: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.oneOf(["today", "24h", "7d", "30d", "60d"]).isRequired,
      label: PropTypes.string.isRequired,
    }),
  ),
  size: PropTypes.oneOf(["sm", "md", "lg"]),
  className: PropTypes.string,
  "aria-label": PropTypes.string,
};
