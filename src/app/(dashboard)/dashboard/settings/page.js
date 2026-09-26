"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Input from "@/shared/components/Input";
import EmptyState from "@/shared/components/EmptyState";
import { Skeleton } from "@/shared/components/Loading";
import Button from "@/shared/components/Button";
import ConfigTransfer from "./sections/ConfigTransfer";
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
import { filterRows, sectionAnchors } from "./registry";
import { LOCALE_COOKIE, normalizeLocale } from "@/i18n/config";

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
  const [settings, setSettings] = useState({ requireLogin: true });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [locale, setLocale] = useState("en");
  const [savedTick, setSavedTick] = useState(0);
  const [dataVersion, setDataVersion] = useState(0);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSettings(data);
    } catch {
      setError("Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
    setLocale(getLocaleFromCookie());
  }, [loadSettings]);

  // Deep-link support (/dashboard/profile#sso, legacy redirects): scroll once
  // the sections are mounted, and on later hash changes.
  useEffect(() => {
    if (loading) return undefined;
    const scrollToHash = () => {
      const hash = window.location.hash.slice(1);
      if (hash) document.getElementById(hash)?.scrollIntoView({ block: "start" });
    };
    scrollToHash();
    window.addEventListener("hashchange", scrollToHash);
    return () => window.removeEventListener("hashchange", scrollToHash);
  }, [loading]);

  // `/` focuses search from anywhere on the page
  useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
        e.preventDefault();
        document.getElementById("settings-search")?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onSettingsChange = useCallback(
    (patch) => {
      if (!patch) {
        loadSettings();
        // An import may have changed pricing overrides or combos, which live
        // outside the settings GET — bump the key so PricingSection reloads.
        setDataVersion((v) => v + 1);
        return;
      }
      setSettings((prev) => ({ ...prev, ...patch }));
      setSavedTick((n) => n + 1);
    },
    [loadSettings],
  );

  const anchors = useMemo(() => sectionAnchors(), []);
  const filtered = filterRows(query);
  const visibleIds = new Set(filtered.map((s) => s.id));
  const navAnchors = anchors.filter((a) => !query || visibleIds.has(a.id));

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
        <Input
          id="settings-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings… (press / to focus)"
          icon="search"
          aria-label="Search settings"
        />
      </div>

      <SettingsAnchorNav sections={navAnchors.length > 0 ? navAnchors : anchors} />

      {/* Sections: two-column masonry at ≥1280px via CSS columns */}
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
        <div className="columns-1 gap-6 xl:columns-2 [&>*]:mb-6 [&>*]:break-inside-avoid">
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
            <TokenSaverSection settings={settings} onSettingsChange={onSettingsChange} />
          )}
          {visibleIds.has("providers") && (
            <ProvidersModelsSection settings={settings} onSettingsChange={onSettingsChange} />
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
  );
}
