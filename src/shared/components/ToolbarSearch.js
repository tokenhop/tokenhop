"use client";

import PropTypes from "prop-types";
import { useRef } from "react";
import Input from "./Input";
import Kbd from "./Kbd";
import { cn } from "@/shared/utils/cn";
import useSlashShortcut from "@/shared/hooks/useSlashShortcut";

/**
 * Page toolbar search: shared Input with a search icon and a "/" Kbd
 * hint (sm+). Wires the shared useSlashShortcut hook so "/" focuses
 * and selects it from anywhere on the page.
 *
 * @param {object} props
 * @param {string} props.value Current query text.
 * @param {(event: import("react").ChangeEvent<HTMLInputElement>) => void} props.onChange Change handler; receives the input event.
 * @param {string} props.ariaLabel Accessible name (aria-label), required.
 * @param {string} [props.placeholder] Placeholder text.
 * @param {string} [props.id] Input id (also the focus target for "/").
 * @param {string} [props.className] Wrapper classes (e.g. toolbar width/alignment).
 * @param {string} [props.inputClassName] Extra classes on the input element.
 */
export default function ToolbarSearch({
  value,
  onChange,
  ariaLabel,
  placeholder,
  id,
  className,
  inputClassName,
}) {
  const inputRef = useRef(null);
  useSlashShortcut(inputRef);
  return (
    <div className={cn("relative", className)}>
      <Input
        ref={inputRef}
        id={id}
        type="search"
        icon="search"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        aria-label={ariaLabel}
        inputClassName={cn("min-h-10 sm:pe-10", inputClassName)}
      />
      <span
        className="pointer-events-none absolute inset-y-0 end-3 hidden items-center sm:flex"
        aria-hidden="true"
      >
        <Kbd>/</Kbd>
      </span>
    </div>
  );
}

ToolbarSearch.propTypes = {
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  ariaLabel: PropTypes.string.isRequired,
  placeholder: PropTypes.string,
  id: PropTypes.string,
  className: PropTypes.string,
  inputClassName: PropTypes.string,
};
