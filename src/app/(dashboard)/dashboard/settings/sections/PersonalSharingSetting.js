"use client";

import PropTypes from "prop-types";
import SettingRow from "@/shared/components/SettingRow";
import Toggle from "@/shared/components/Toggle";
import { useSettingsField } from "../useSettingsField";

/**
 * Instance toggle that lets owners and admins share subscription (personal
 * OAuth) connections, after a per-share terms acknowledgement (YAN-376).
 * GET /api/settings only returns the key to instance managers while
 * multi-user is on, so its absence hides the row everywhere else.
 */
export default function PersonalSharingSetting({ settings, onSaved }) {
  const present = Object.hasOwn(settings, "allowPersonalConnectionGrants");
  const field = useSettingsField(
    "allowPersonalConnectionGrants",
    settings.allowPersonalConnectionGrants === true,
    { onSaved },
  );
  if (!present) return null;
  return (
    <>
      <SettingRow
        label="Allow sharing subscription connections"
        description="Lets owners and admins share personal subscription accounts (Claude, ChatGPT, Copilot) after accepting the provider terms warning. Most provider terms forbid account sharing."
        settingKey="allowPersonalConnectionGrants"
        control={
          <Toggle
            checked={field.value}
            onChange={(next) => field.set(next)}
            disabled={field.saving}
            aria-label="Allow sharing subscription connections"
          />
        }
      />
      {field.error && (
        <p className="py-2 text-xs text-err" role="alert">
          {field.error}
        </p>
      )}
    </>
  );
}

PersonalSharingSetting.propTypes = {
  settings: PropTypes.object.isRequired,
  onSaved: PropTypes.func,
};
