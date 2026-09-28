"use client";

import PropTypes from "prop-types";
import SectionCard from "@/shared/components/SectionCard";
import SettingRow from "@/shared/components/SettingRow";
import Toggle from "@/shared/components/Toggle";
import NumberStepper from "@/shared/components/NumberStepper";
import UnitInput from "@/shared/components/UnitInput";
import Callout from "@/shared/components/Callout";
import { useSettingsField } from "../useSettingsField";

function FieldError({ error }) {
  if (!error) return null;
  return (
    <p className="py-2 text-xs text-err" role="alert">
      {error}
    </p>
  );
}

FieldError.propTypes = { error: PropTypes.string };

/**
 * Observability & logs section (YAN-310 + YAN-312, one coherent section):
 * - Record request details (enableObservability) + storage-limit numerics
 *   (max records, batch size, flush interval, max payload KB).
 * - Log every request file logs (requestLogsEnabled) + Translator page
 *   visibility (translatorEnabled), each with env precedence: an explicit
 *   env var wins and locks the toggle with a ".env overrides" pill.
 * Single source of truth for the env override: `requestLogsOverridden` /
 * `translatorOverridden` from GET /api/settings (`requestLogEnvOverride`
 * kept as a legacy alias for the request-logs flag).
 * Max payload size is kilobytes in code (requestDetailsRepo multiplies by
 * 1024) — labeled as KB here. Config cache refreshes within ~5s, so no
 * restart is required.
 */
export default function ObservabilitySection({ settings, onSettingsChange }) {
  const onSaved = (key) => (value) => onSettingsChange?.({ [key]: value });

  const enabled = useSettingsField("enableObservability", settings.enableObservability === true, {
    onSaved: onSaved("enableObservability"),
  });
  // Env precedence (single source of truth): an explicit ENABLE_REQUEST_LOGS
  // wins over every stored flag, so all recording toggles lock, not just one.
  const requestLogsOverridden =
    settings.requestLogsOverridden === true || settings.requestLogEnvOverride === true;
  const translatorOverridden = settings.translatorOverridden === true;
  const maxRecords = useSettingsField(
    "observabilityMaxRecords",
    settings.observabilityMaxRecords ?? 1000,
    { debounced: true, onSaved: onSaved("observabilityMaxRecords") },
  );
  const batchSize = useSettingsField(
    "observabilityBatchSize",
    settings.observabilityBatchSize ?? 20,
    { debounced: true, onSaved: onSaved("observabilityBatchSize") },
  );
  const flushInterval = useSettingsField(
    "observabilityFlushIntervalMs",
    settings.observabilityFlushIntervalMs ?? 5000,
    { debounced: true, onSaved: onSaved("observabilityFlushIntervalMs") },
  );
  const maxJsonKb = useSettingsField(
    "observabilityMaxJsonSize",
    settings.observabilityMaxJsonSize ?? 5,
    { debounced: true, onSaved: onSaved("observabilityMaxJsonSize") },
  );
  const requestLogsField = useSettingsField(
    "requestLogsEnabled",
    settings.requestLogsEnabled === true,
    { onSaved: onSaved("requestLogsEnabled") },
  );
  const translatorField = useSettingsField(
    "translatorEnabled",
    settings.translatorEnabled === true,
    { onSaved: onSaved("translatorEnabled") },
  );

  const off = !enabled.value;
  const requestLogsChecked = requestLogsOverridden
    ? settings.enableRequestLogs === true
    : requestLogsField.value;
  const translatorChecked = translatorOverridden
    ? settings.enableTranslator === true
    : translatorField.value;

  return (
    <div id="logs" className="scroll-mt-24 space-y-4">
      <SectionCard
        icon="monitoring"
        title="Observability & logs"
        subtitle="What gets recorded, and for how long."
      />
      <div className="rounded-2xl border border-line bg-panel p-5 shadow-card divide-y divide-line">
        <SettingRow
          label="Record request details"
          description={
            requestLogsOverridden ? (
              <>
                Set by <code className="font-mono">ENABLE_REQUEST_LOGS</code> in .env — the env
                wins, this toggle is read-only.
              </>
            ) : (
              "Full payloads in Usage → Request log."
            )
          }
          settingKey="enableObservability"
          control={
            <Toggle
              checked={enabled.value === true}
              onChange={(next) => enabled.set(next)}
              disabled={enabled.saving || requestLogsOverridden}
              aria-label="Record request details"
            />
          }
        />
        <FieldError error={enabled.error} />

        <div className="py-4">
          <p className="text-[15px] font-semibold text-text">Storage limits</p>
          <p className="mt-0.5 text-[13px] text-muted">
            New in UI. Applies within ~5 seconds — no restart required.
          </p>
          <div className={`mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2${off ? " opacity-50" : ""}`}>
            <NumberStepper
              label="Max records"
              value={maxRecords.value}
              onChange={(next) => maxRecords.set(next)}
              min={1}
              disabled={off || maxRecords.saving}
              error={maxRecords.error || undefined}
            />
            <NumberStepper
              label="Batch size"
              value={batchSize.value}
              onChange={(next) => batchSize.set(next)}
              min={1}
              disabled={off || batchSize.saving}
              error={batchSize.error || undefined}
            />
            <UnitInput
              label="Flush every"
              value={flushInterval.value ?? ""}
              onChange={(e) => flushInterval.set(Number(e.target.value))}
              unit="ms"
              disabled={off || flushInterval.saving}
              error={flushInterval.error ? String(flushInterval.error) : undefined}
            />
            <UnitInput
              label="Max payload size"
              value={maxJsonKb.value ?? ""}
              onChange={(e) => maxJsonKb.set(Number(e.target.value))}
              unit="KB"
              hint="Kilobytes per payload (code multiplies by 1024)."
              disabled={off || maxJsonKb.saving}
              error={maxJsonKb.error ? String(maxJsonKb.error) : undefined}
            />
          </div>
          <div className="mt-3">
            <Callout variant="info" title="No restart needed">
              Changes take effect within ~5 seconds via the runtime config cache.
            </Callout>
          </div>
        </div>

        <SettingRow
          label="Log every request to console"
          description={
            requestLogsOverridden
              ? "Controlled by ENABLE_REQUEST_LOGS in .env — change it there and restart."
              : "Writes request/response logs under logs/ for debugging."
          }
          settingKey="ENABLE_REQUEST_LOGS"
          control={
            <div className="flex items-center gap-2">
              {requestLogsOverridden && (
                <span className="rounded-full bg-raised px-2 py-0.5 font-mono text-[11px] text-muted">
                  .env overrides
                </span>
              )}
              <Toggle
                checked={requestLogsChecked}
                onChange={(next) => requestLogsField.set(next)}
                disabled={requestLogsOverridden || requestLogsField.saving}
                aria-label="Log every request to console"
              />
            </div>
          }
        />
        {requestLogsField.error && (
          <p className="py-2 text-xs text-err" role="alert">
            {requestLogsField.error}
          </p>
        )}
        <SettingRow
          label="Show Translator page"
          description={
            translatorOverridden
              ? "Controlled by ENABLE_TRANSLATOR in .env — change it there and restart."
              : "Debug tool for format translation."
          }
          settingKey="ENABLE_TRANSLATOR"
          control={
            <div className="flex items-center gap-2">
              {translatorOverridden && (
                <span className="rounded-full bg-raised px-2 py-0.5 font-mono text-[11px] text-muted">
                  .env overrides
                </span>
              )}
              <Toggle
                checked={translatorChecked}
                onChange={(next) => translatorField.set(next)}
                disabled={translatorOverridden || translatorField.saving}
                aria-label="Show Translator page"
              />
            </div>
          }
        />
        {translatorField.error && (
          <p className="py-2 text-xs text-err" role="alert">
            {translatorField.error}
          </p>
        )}
      </div>
    </div>
  );
}

ObservabilitySection.propTypes = {
  settings: PropTypes.object.isRequired,
  onSettingsChange: PropTypes.func,
};
