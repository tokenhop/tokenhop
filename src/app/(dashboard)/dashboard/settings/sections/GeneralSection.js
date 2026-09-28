"use client";

import PropTypes from "prop-types";
import { useEffect, useState } from "react";
import { useTheme } from "@/shared/hooks/useTheme";
import SectionCard from "@/shared/components/SectionCard";
import SettingRow from "@/shared/components/SettingRow";
import SegmentedControl from "@/shared/components/SegmentedControl";
import Button from "@/shared/components/Button";
import Select from "@/shared/components/Select";
import LanguageSwitcher from "@/shared/components/LanguageSwitcher";
import { LOCALE_NAMES } from "@/i18n/config";
import { applyDensity } from "@/lib/density";
import { useSettingsField } from "../useSettingsField";
import { START_PAGE_OPTIONS } from "../startPageOptions";

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: "light_mode" },
  { value: "dark", label: "Dark", icon: "dark_mode" },
  { value: "system", label: "System", icon: "contrast" },
];

const DENSITY_OPTIONS = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

/**
 * General section: theme, language, start page and density preferences.
 * startPage/uiDensity persist via /api/settings; the density cookie keeps the
 * compact class flash-free across reloads.
 */
export default function GeneralSection({
  settings,
  locale = "en",
  onLocaleChange,
  onSettingsChange,
}) {
  const { theme, setTheme } = useTheme();
  const [langOpen, setLangOpen] = useState(false);

  const startPageField = useSettingsField("startPage", settings.startPage || "/dashboard", {
    onSaved: (value) => onSettingsChange?.({ startPage: value }),
  });
  const densityField = useSettingsField("uiDensity", settings.uiDensity || "comfortable", {
    onSaved: (value) => {
      applyDensity(value);
      onSettingsChange?.({ uiDensity: value });
    },
  });

  // Apply the stored density on load: the pre-paint script only trusts the
  // cookie, which can lag behind the DB value saved from another browser.
  // biome-ignore lint/correctness/useExhaustiveDependencies: apply on server-value changes only.
  useEffect(() => {
    if (settings.uiDensity) applyDensity(settings.uiDensity);
  }, [settings.uiDensity]);

  return (
    <div id="general" className="scroll-mt-24 space-y-4">
      <SectionCard icon="tune" title="General" subtitle="Look, language and where you land." />
      <div className="rounded-2xl border border-line bg-panel p-5 shadow-card divide-y divide-line">
        <SettingRow
          label="Theme"
          description="Dark, light, or follow your system."
          settingKey="theme"
          control={
            <SegmentedControl
              options={THEME_OPTIONS}
              value={theme}
              onChange={setTheme}
              aria-label="Theme preference"
            />
          }
        />
        <SettingRow
          label="Language"
          description="Dashboard language."
          settingKey="language"
          control={
            <div className="flex items-center gap-2">
              <Button variant="secondary" icon="language" onClick={() => setLangOpen(true)}>
                {LOCALE_NAMES[locale] || locale}
              </Button>
              <LanguageSwitcher
                hideTrigger
                isOpen={langOpen}
                onClose={(next) => {
                  setLangOpen(false);
                  if (next) onLocaleChange?.(next);
                }}
              />
            </div>
          }
        />
        <SettingRow
          label="Start page"
          description="Where you land after login and on `/`."
          settingKey="startPage"
          control={
            <div className="w-56">
              <Select
                aria-label="Start page"
                options={START_PAGE_OPTIONS}
                value={startPageField.value}
                onChange={(e) => startPageField.set(e.target.value)}
                disabled={startPageField.saving}
              />
              {startPageField.error && (
                <p className="mt-1 text-xs text-err" role="alert">
                  {startPageField.error}
                </p>
              )}
            </div>
          }
        />
        <SettingRow
          label="Density"
          description="Compact tightens spacing and row heights."
          settingKey="uiDensity"
          control={
            <div>
              <SegmentedControl
                options={DENSITY_OPTIONS}
                value={densityField.value}
                onChange={densityField.set}
                aria-label="Density preference"
              />
              {densityField.error && (
                <p className="mt-1 text-xs text-err" role="alert">
                  {densityField.error}
                </p>
              )}
            </div>
          }
        />
      </div>
    </div>
  );
}

GeneralSection.propTypes = {
  settings: PropTypes.object.isRequired,
  locale: PropTypes.string,
  onLocaleChange: PropTypes.func,
  onSettingsChange: PropTypes.func,
};
