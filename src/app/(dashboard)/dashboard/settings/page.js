"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { refreshShellStatus } from "@/shared/hooks/useShellStatus";
import { useAuthStatusState } from "@/shared/hooks/useAuthStatus";
import { accountView } from "@/shared/utils/account";
import AccountSection from "./sections/AccountSection";
import { layoutFor } from "./settingsTiers";
import { SettingsScopeContext } from "./settingsApi";
import { useSettingsData } from "./useSettingsData";
import EmptyState from "@/shared/components/EmptyState";
import ToolbarSearch from "@/shared/components/ToolbarSearch";
import { Skeleton } from "@/shared/components/Loading";
import Button from "@/shared/components/Button";
import ConfigTransfer from "./sections/ConfigTransfer";
import AboutSection from "./sections/AboutSection";
import GeneralSection from "./sections/GeneralSection";
import SecuritySection from "./sections/SecuritySection";
import SsoSection from "./sections/SsoSection";
import RoutingSection from "./sections/RoutingSection";
import ReliabilitySection from "./sections/ReliabilitySection";
import NetworkSection from "./sections/NetworkSection";
import TokenSaverSection from "./sections/TokenSaverSection";
import ProvidersModelsSection from "./sections/ProvidersModelsSection";
import ObservabilitySection from "./sections/ObservabilitySection";
import PricingSection from "./sections/PricingSection";
import DataSection from "./sections/DataSection";
import EnvironmentSection from "./sections/EnvironmentSection";
import DangerSection from "./sections/DangerSection";
import SettingsAnchorNav from "./SettingsAnchorNav";
import { filterRows } from "./registry";
import { LOCALE_COOKIE, normalizeLocale } from "@/i18n/config";
import { cn } from "@/shared/utils/cn";

function getLocaleFromCookie() {
  if (typeof document === "undefined") return "en";
  const cookie = document.cookie.split(";").find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : "en";
  return normalizeLocale(value);
}

/**
 * Consolidated settings page: data-driven section registry, search with `/`
 * shortcut, scroll-spy anchor nav, and an aria-live save-status line.
 */
export default function SettingsPage() {
  // YAN-371: tiered layout and scoped saves only while multi-user is active;
  // inactive keeps the legacy groups, sections and /api/settings I/O.
  const { status: authStatus, loaded: authLoaded } = useAuthStatusState();
  const view = useMemo(() => accountView(authStatus), [authStatus]);
  const {
    groups: SETTINGS_GROUPS,
    sections: SETTINGS_SECTIONS,
    canManageInstance,
  } = useMemo(() => layoutFor(view), [view]);
  const workspaceId = view.active ? (view.activeWorkspace?.id ?? null) : null;
  const scope = useMemo(() => (view.active ? { workspaceId } : null), [view.active, workspaceId]);
  const { settings, setSettings, loading, error, loadSettings } = useSettingsData({
    ready: authLoaded,
    scope,
    canManageInstance,
  });
  const [query, setQuery] = useState("");
  const [locale, setLocale] = useState("en");
  const [savedTick, setSavedTick] = useState(0);
  const [dataVersion, setDataVersion] = useState(0);
  const [activeId, setActiveId] = useState("general");

  useEffect(() => {
    setLocale(getLocaleFromCookie());
  }, []);

  // Preserve existing #section deep links, including legacy redirects. An id
  // the viewer can't see (e.g. #security for a member) falls back to the first.
  useEffect(() => {
    const selectHash = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (SETTINGS_SECTIONS.some((section) => section.id === id)) setActiveId(id);
      else if (!SETTINGS_SECTIONS.some((section) => section.id === activeId)) {
        setActiveId(SETTINGS_GROUPS[0].sections[0]);
      }
    };
    selectHash();
    window.addEventListener("hashchange", selectHash);
    return () => window.removeEventListener("hashchange", selectHash);
  }, [SETTINGS_SECTIONS, SETTINGS_GROUPS, activeId]);

  const selectSection = useCallback((id) => {
    setActiveId(id);
    window.history.replaceState(null, "", `#${id}`);
    document.querySelector("main .custom-scrollbar")?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const onSettingsChange = useCallback(
    (patch) => {
      if (!patch) {
        loadSettings();
        // An import may have changed pricing overrides or combos, which live
        // outside the settings GET — bump the key so PricingSection reloads.
        setDataVersion((v) => v + 1);
        refreshShellStatus();
        return;
      }
      setSettings((prev) => ({ ...prev, ...patch }));
      setSavedTick((n) => n + 1);
    },
    [loadSettings, setSettings],
  );

  const filtered = filterRows(query, SETTINGS_SECTIONS);
  const visibleIds = new Set(query ? filtered.map((s) => s.id) : [activeId]);
  const activeSection = SETTINGS_SECTIONS.find((section) => section.id === activeId);

  // Pricing modal opens from the deep link ?editPricing=1 (legacy
  // /dashboard/settings/pricing redirect) or from the Pricing section.
  const [pricingModalOpen, setPricingModalOpen] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("editPricing") === "1") {
      setPricingModalOpen(true);
    }
  }, []);
  const handlePricingModalChange = useCallback((open) => {
    setPricingModalOpen(open);
    if (!open) {
      // Consume the deep-link param so a refresh does not reopen the modal.
      const url = new URL(window.location.href);
      url.searchParams.delete("editPricing");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

  return (
    <SettingsScopeContext.Provider value={scope}>
      <div className="mx-auto max-w-6xl space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm text-muted">
                Changes save instantly.{" "}
                <span aria-live="polite" aria-atomic="true" className="font-medium text-ok">
                  {savedTick > 0 ? `All changes saved (${savedTick})` : " "}
                </span>
              </p>
            </div>
            <ConfigTransfer onSettingsChange={onSettingsChange} />
          </div>
          <ToolbarSearch
            id="settings-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings"
            ariaLabel="Search settings"
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
          {query ? (
            <p className="text-sm text-muted lg:col-span-2" aria-live="polite">
              {filtered.reduce((n, section) => n + section.rows.length, 0)} matching settings in{" "}
              {filtered.length} sections
            </p>
          ) : (
            <SettingsAnchorNav
              groups={SETTINGS_GROUPS}
              sections={SETTINGS_SECTIONS}
              activeId={activeId}
              onSelect={selectSection}
            />
          )}
          <div className={cn("min-w-0", query && "lg:col-span-2")}>
            {!query && activeSection && (
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
                {SETTINGS_GROUPS.find((group) => group.sections.includes(activeId))?.title} /{" "}
                <span className="text-text">{activeSection.title}</span>
              </p>
            )}
            {loading ? (
              <div className="space-y-4">
                <Skeleton />
                <Skeleton />
              </div>
            ) : error ? (
              <EmptyState
                icon="error"
                title="Could not load settings"
                body={error}
                action={<Button onClick={loadSettings}>Retry</Button>}
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon="search"
                title="No settings match"
                body={`Nothing matches “${query}”. Try a different search.`}
                action={
                  <Button variant="ghost" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                }
              />
            ) : (
              <div className="space-y-6">
                {view.active && visibleIds.has("account") && <AccountSection />}
                {visibleIds.has("about") && <AboutSection />}
                {visibleIds.has("general") && (
                  <GeneralSection
                    settings={settings}
                    locale={locale}
                    onLocaleChange={setLocale}
                    onSettingsChange={onSettingsChange}
                  />
                )}
                {visibleIds.has("security") && (
                  <SecuritySection settings={settings} onSettingsChange={onSettingsChange} />
                )}
                {visibleIds.has("sso") && (
                  <SsoSection settings={settings} onSettingsChange={onSettingsChange} />
                )}
                {visibleIds.has("routing") && (
                  <RoutingSection settings={settings} onSettingsChange={onSettingsChange} />
                )}
                {visibleIds.has("reliability") && (
                  <ReliabilitySection settings={settings} onSettingsChange={onSettingsChange} />
                )}
                {visibleIds.has("network") && (
                  <NetworkSection settings={settings} onSettingsChange={onSettingsChange} />
                )}
                {visibleIds.has("token-saver") && (
                  <TokenSaverSection
                    settings={settings}
                    onSettingsChange={onSettingsChange}
                    canManageInstance={canManageInstance}
                  />
                )}
                {visibleIds.has("providers") && (
                  <ProvidersModelsSection
                    settings={settings}
                    onSettingsChange={onSettingsChange}
                    canManageInstance={canManageInstance}
                  />
                )}
                {visibleIds.has("logs") && (
                  <ObservabilitySection settings={settings} onSettingsChange={onSettingsChange} />
                )}
                {visibleIds.has("pricing") && (
                  <PricingSection
                    key={`pricing-${dataVersion}`}
                    modalOpen={pricingModalOpen}
                    onModalChange={handlePricingModalChange}
                  />
                )}
                {visibleIds.has("data") && <DataSection onSettingsChange={onSettingsChange} />}
                {visibleIds.has("environment") && <EnvironmentSection />}
                {visibleIds.has("danger") && <DangerSection />}
              </div>
            )}
          </div>
        </div>
      </div>
    </SettingsScopeContext.Provider>
  );
}
