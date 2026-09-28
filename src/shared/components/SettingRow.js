"use client";

import PropTypes from "prop-types";

/**
 * Settings row: label, description + optional mono setting key on one side,
 * control on the other. Stacks vertically on narrow containers via flex-wrap.
 * Pass `aria-disabled` for off-state rows: text keeps full contrast while
 * assistive tech hears the state (YAN-314).
 */
export default function SettingRow({ label, description, settingKey, control, className }) {
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4${className ? ` ${className}` : ""}`}
    >
      <div className="min-w-52 flex-1">
        <p className="text-[15px] font-semibold text-text">{label}</p>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
        {settingKey && <p className="mt-0.5 font-mono text-[11px] text-subtle">{settingKey}</p>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

SettingRow.propTypes = {
  label: PropTypes.node.isRequired,
  description: PropTypes.node,
  settingKey: PropTypes.string,
  control: PropTypes.node.isRequired,
  className: PropTypes.string,
};
