"use client";

import Link from "next/link";
import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";

/**
 * Card header text link: client-side navigation in coral, with an optional
 * trailing arrow that mirrors in RTL.
 *
 * @param {object} props
 * @param {string} props.href internal route
 * @param {React.ReactNode} props.children link text (plain English literal)
 * @param {boolean} [props.showArrow=true]
 * @param {string} [props.className] replaces the default coral text styles
 */
export default function CardLink({ href, children, showArrow = true, className }) {
  return (
    <Link
      href={href}
      className={cn(className || "text-[13px] font-semibold text-coral-ink hover:text-coral")}
    >
      {children}
      {showArrow ? (
        <>
          {" "}
          <span aria-hidden="true" className="inline-block rtl:-scale-x-100">
            →
          </span>
        </>
      ) : null}
    </Link>
  );
}

CardLink.propTypes = {
  href: PropTypes.string.isRequired,
  children: PropTypes.node.isRequired,
  showArrow: PropTypes.bool,
  className: PropTypes.string,
};
