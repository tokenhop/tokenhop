"use client";

import PropTypes from "prop-types";
import { useEffect } from "react";
import SectionCard from "@/shared/components/SectionCard";
import SettingRow from "@/shared/components/SettingRow";
import Toggle from "@/shared/components/Toggle";
import SegmentedControl from "@/shared/components/SegmentedControl";
import NumberStepper from "@/shared/components/NumberStepper";
import Input from "@/shared/components/Input";
import Badge from "@/shared/components/Badge";
import { PONYTAIL_LEVELS } from "../../endpoint/endpointConstants";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";
import { useSettingsField } from "../useSettingsField";
import { useState } from "react";
import {
  TOKEN_SAVER_DEFAULTS,
  cavemanLevelDescription,
  coerceCavemanLevel,
  coercePonytailLevel,
  isHeadroomUrlFromEnv,
  ponytailLevelDescription,
  visibleCavemanLevels,
} from "./tokenSaverHelpers";

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
 * Token saver section: the same store as the Token saver page. Top-level
 * toggles save immediately; sub-fields go disabled when their toggle is off.
 * 文 (wenyan) caveman levels only appear where the locale supports them.
 */
export default function TokenSaverSection({ settings, onSettingsChange }) {
  const onSaved = (key) => (value) => onSettingsChange?.({ [key]: value });

  const rtk = useSettingsField("rtkEnabled", settings.rtkEnabled ?? true, {
    onSaved: onSaved("rtkEnabled"),
  });
  const headroom = useSettingsField("headroomEnabled", settings.headroomEnabled ?? false, {
    onSaved: onSaved("headroomEnabled"),
  });
  const headroomUrl = useSettingsField(
    "headroomUrl",
    settings.headroomUrl ?? TOKEN_SAVER_DEFAULTS.headroomUrl,
    { debounced: true, onSaved: onSaved("headroomUrl") },
  );
  const headroomTimeout = useSettingsField(
    "headroomTimeoutMs",
    settings.headroomTimeoutMs ?? TOKEN_SAVER_DEFAULTS.headroomTimeoutMs,
    { onSaved: onSaved("headroomTimeoutMs") },
  );
  const headroomCompress = useSettingsField(
    "headroomCompressUserMessages",
    settings.headroomCompressUserMessages ?? false,
    { onSaved: onSaved("headroomCompressUserMessages") },
  );
  const caveman = useSettingsField("cavemanEnabled", settings.cavemanEnabled ?? false, {
    onSaved: onSaved("cavemanEnabled"),
  });
  const cavemanLevel = useSettingsField(
    "cavemanLevel",
    coerceCavemanLevel(getCurrentLocale(), settings.cavemanLevel ?? "full"),
    { onSaved: onSaved("cavemanLevel") },
  );
  const ponytail = useSettingsField("ponytailEnabled", settings.ponytailEnabled ?? false, {
    onSaved: onSaved("ponytailEnabled"),
  });
  const ponytailLevel = useSettingsField(
    "ponytailLevel",
    coercePonytailLevel(settings.ponytailLevel ?? "full"),
    { onSaved: onSaved("ponytailLevel") },
  );
  const pxpipe = useSettingsField("pxpipeEnabled", settings.pxpipeEnabled ?? false, {
    onSaved: onSaved("pxpipeEnabled"),
  });
  const pxpipeMinChars = useSettingsField(
    "pxpipeMinChars",
    settings.pxpipeMinChars ?? TOKEN_SAVER_DEFAULTS.pxpipeMinChars,
    { onSaved: onSaved("pxpipeMinChars") },
  );
  const pxpipeTimeout = useSettingsField(
    "pxpipeTimeoutMs",
    settings.pxpipeTimeoutMs ?? TOKEN_SAVER_DEFAULTS.pxpipeTimeoutMs,
    { onSaved: onSaved("pxpipeTimeoutMs") },
  );
  const pxpipeAutoInstall = useSettingsField(
    "pxpipeAutoInstall",
    settings.pxpipeAutoInstall ?? true,
    { onSaved: onSaved("pxpipeAutoInstall") },
  );

  const [locale, setLocale] = useState("en");
  useEffect(() => {
    setLocale(getCurrentLocale());
    return onLocaleChange(() => setLocale(getCurrentLocale()));
  }, []);
  const levels = visibleCavemanLevels(locale);
  const safeCavemanLevel = coerceCavemanLevel(locale, cavemanLevel.value ?? "full");

  const headroomOff = !headroom.value;
  const cavemanOff = !caveman.value;
  const ponytailOff = !ponytail.value;
  const pxpipeOff = !pxpipe.value;
  const urlFromEnv = isHeadroomUrlFromEnv(settings);

  return (
    <div id="token-saver" className="scroll-mt-24 space-y-4">
      <SectionCard
        icon="bolt"
        title="Token saver"
        subtitle="Compress tool output, context and replies. Same store as the Token saver page."
      />
      <div className="rounded-2xl border border-line bg-panel p-5 shadow-card divide-y divide-line">
        <SettingRow
          label="Compress tool output"
          description="git/grep/ls/tree/logs → 60-90% fewer input tokens (RTK)."
          settingKey="rtkEnabled"
          control={
            <Toggle
              checked={rtk.value === true}
              onChange={(next) => rtk.set(next)}
              disabled={rtk.saving}
              aria-label="Compress tool output"
            />
          }
        />
        <FieldError error={rtk.error} />

        <SettingRow
          label="Compress context"
          description="Compress prompts via Headroom before routing to the model."
          settingKey="headroomEnabled"
          control={
            <Toggle
              checked={headroom.value === true}
              onChange={(next) => headroom.set(next)}
              disabled={headroom.saving}
              aria-label="Compress context"
            />
          }
        />
        <FieldError error={headroom.error} />
        <SettingRow
          label="Headroom URL"
          description={
            urlFromEnv ? (
              <>
                Set by <code className="font-mono">HEADROOM_URL</code> in .env — the env wins, this
                field is read-only.
              </>
            ) : (
              "Local proxy for Start/Stop, or an external sidecar."
            )
          }
          settingKey="headroomUrl"
          control={
            <div className="w-full sm:min-w-72 sm:max-w-sm">
              <Input
                value={headroomUrl.value ?? ""}
                onChange={(e) => headroomUrl.set(e.target.value)}
                disabled={headroomOff || headroomUrl.saving || urlFromEnv}
                placeholder="http://localhost:8787"
                inputClassName="font-mono"
                aria-label="Headroom URL"
              />
              {urlFromEnv && (
                <div className="mt-1.5">
                  <Badge variant="info" size="sm" icon="lock">
                    .env
                  </Badge>
                </div>
              )}
            </div>
          }
        />
        <FieldError error={headroomUrl.error} />
        <SettingRow
          label="Headroom timeout"
          description="Request timeout, in milliseconds."
          settingKey="headroomTimeoutMs"
          control={
            <div className="w-48">
              <NumberStepper
                label="Headroom timeout"
                value={headroomTimeout.value}
                onChange={(next) => headroomTimeout.set(next)}
                min={1}
                disabled={headroomOff || headroomTimeout.saving}
              />
            </div>
          }
        />
        <FieldError error={headroomTimeout.error} />
        <SettingRow
          label="Compress user messages"
          description="Also compress user turns, not just tool output."
          settingKey="headroomCompressUserMessages"
          control={
            <Toggle
              checked={headroomCompress.value === true}
              onChange={(next) => headroomCompress.set(next)}
              disabled={headroomOff || headroomCompress.saving}
              aria-label="Compress user messages"
            />
          }
        />
        <FieldError error={headroomCompress.error} />

        <SettingRow
          label="Compress LLM output"
          description="Terse-style system prompt → ~65% fewer output tokens (Caveman)."
          settingKey="cavemanEnabled"
          control={
            <Toggle
              checked={caveman.value === true}
              onChange={(next) => caveman.set(next)}
              disabled={caveman.saving}
              aria-label="Compress LLM output"
            />
          }
        />
        <FieldError error={caveman.error} />
        <SettingRow
          label="Caveman level"
          description={cavemanLevelDescription(safeCavemanLevel)}
          settingKey="cavemanLevel"
          control={
            <fieldset disabled={cavemanOff || cavemanLevel.saving}>
              <SegmentedControl
                options={levels.map((lvl) => ({ value: lvl.id, label: lvl.label }))}
                value={safeCavemanLevel}
                onChange={(next) => cavemanLevel.set(next)}
                aria-label="Caveman level"
              />
            </fieldset>
          }
        />
        <FieldError error={cavemanLevel.error} />

        <SettingRow
          label="Lazy senior dev"
          description="Bias the model toward minimal code: YAGNI, reuse stdlib (Ponytail)."
          settingKey="ponytailEnabled"
          control={
            <Toggle
              checked={ponytail.value === true}
              onChange={(next) => ponytail.set(next)}
              disabled={ponytail.saving}
              aria-label="Lazy senior dev"
            />
          }
        />
        <FieldError error={ponytail.error} />
        <SettingRow
          label="Ponytail level"
          description={ponytailLevelDescription(ponytailLevel.value)}
          settingKey="ponytailLevel"
          control={
            <fieldset disabled={ponytailOff || ponytailLevel.saving}>
              <SegmentedControl
                options={PONYTAIL_LEVELS.map((lvl) => ({ value: lvl.id, label: lvl.label }))}
                value={coercePonytailLevel(ponytailLevel.value)}
                onChange={(next) => ponytailLevel.set(next)}
                aria-label="Ponytail level"
              />
            </fieldset>
          }
        />
        <FieldError error={ponytailLevel.error} />

        <SettingRow
          label={
            <span className="inline-flex items-center gap-2">
              Prompts as images
              <Badge variant="info" size="sm" icon="science">
                Experimental
              </Badge>
            </span>
          }
          description="Large context becomes optimized images before the LLM (PXPIPE)."
          settingKey="pxpipeEnabled"
          control={
            <Toggle
              checked={pxpipe.value === true}
              onChange={(next) => pxpipe.set(next)}
              disabled={pxpipe.saving}
              aria-label="Prompts as images"
            />
          }
        />
        <FieldError error={pxpipe.error} />
        <SettingRow
          label="Minimum prompt size"
          description="Requests smaller than this bypass PXPIPE as-is (chars)."
          settingKey="pxpipeMinChars"
          control={
            <div className="w-48">
              <NumberStepper
                label="Minimum prompt size"
                value={pxpipeMinChars.value}
                onChange={(next) => pxpipeMinChars.set(next)}
                min={0}
                disabled={pxpipeOff || pxpipeMinChars.saving}
              />
            </div>
          }
        />
        <FieldError error={pxpipeMinChars.error} />
        <SettingRow
          label="PXPIPE timeout"
          description="Request timeout, in milliseconds."
          settingKey="pxpipeTimeoutMs"
          control={
            <div className="w-48">
              <NumberStepper
                label="PXPIPE timeout"
                value={pxpipeTimeout.value}
                onChange={(next) => pxpipeTimeout.set(next)}
                min={1}
                disabled={pxpipeOff || pxpipeTimeout.saving}
              />
            </div>
          }
        />
        <FieldError error={pxpipeTimeout.error} />
        <SettingRow
          label="Auto-install PXPIPE"
          description="Install the proxy package on first use when missing."
          settingKey="pxpipeAutoInstall"
          control={
            <Toggle
              checked={pxpipeAutoInstall.value === true}
              onChange={(next) => pxpipeAutoInstall.set(next)}
              disabled={pxpipeOff || pxpipeAutoInstall.saving}
              aria-label="Auto-install PXPIPE"
            />
          }
        />
        <FieldError error={pxpipeAutoInstall.error} />
      </div>
    </div>
  );
}

TokenSaverSection.propTypes = {
  settings: PropTypes.object.isRequired,
  onSettingsChange: PropTypes.func,
};
