"use client";

import PropTypes from "prop-types";
import SettingRow from "@/shared/components/SettingRow";
import Toggle from "@/shared/components/Toggle";
import { useSettingsField } from "../useSettingsField";

/**
 * Instance toggle that lets budget webhooks (YAN-1831) reach private networks
 * (RFC1918, CGNAT, loopback, ULA, localhost) and plain http. Link-local and
 * cloud metadata addresses stay blocked either way. GET /api/settings only
 * returns the key to instance managers, so its absence hides the row.
 */
export default function BudgetWebhookPrivateNetworksSetting({ settings, onSaved }) {
  const present = Object.hasOwn(settings, "budgetWebhookAllowPrivateNetworks");
  const field = useSettingsField(
    "budgetWebhookAllowPrivateNetworks",
    settings.budgetWebhookAllowPrivateNetworks === true,
    { onSaved },
  );
  if (!present) return null;
  return (
    <>
      <SettingRow
        label="Budget webhooks: allow private networks"
        description="Lets budget webhooks reach private and loopback addresses and plain http. Link-local and cloud metadata addresses stay blocked."
        settingKey="budgetWebhookAllowPrivateNetworks"
        control={
          <Toggle
            checked={field.value}
            onChange={(next) => field.set(next)}
            disabled={field.saving}
            aria-label="Budget webhooks: allow private networks"
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

BudgetWebhookPrivateNetworksSetting.propTypes = {
  settings: PropTypes.object.isRequired,
  onSaved: PropTypes.func,
};
