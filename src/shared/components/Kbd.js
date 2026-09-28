"use client";

import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";

/** Signal keyboard hint chip: 6px radius, mono, subtle text, line border. */
export default function Kbd({ children, className, ...props }) {
  return (
    <kbd
      {...props}
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-line bg-raised px-1.5",
        "font-mono text-[11px] font-medium text-subtle",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

Kbd.propTypes = {
  children: PropTypes.node.isRequired,
  className: PropTypes.string,
};
