"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Callout,
  Card,
  Field,
  Input,
  SegmentedControl,
  Skeleton,
  Toggle,
} from "@/shared/components";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";
import usePeriod from "@/shared/hooks/usePeriod";
import { WENYAN_LOCALES, CAVEMAN_LEVELS, PONYTAIL_LEVELS } from "../endpoint/endpointConstants";
import { TokenSaverHeader, SavingsHero, MethodFooter } from "./SavingsHero";
import {
  HeadroomControls,
  HeadroomModal,
  HeadroomPill,
  headroomPillProps,
} from "./HeadroomControls";
import { useHeadroomExtras } from "./useHeadroomExtras";
import { useSavingsWithFallback } from "./useSavingsWithFallback";
import { fetchJson } from "./tokenSaverApi";

const RTK_CHIPS = ["git log", "git diff", "grep / rg", "ls / tree", "test output", "logs"];

// YAN-303 spec: PXPIPE ("prompts as images") stays hidden on this page, as the
// legacy UI hid it (`{false && ...}`), until a Settings experimental flag exists.
// None exists, so the row is not rendered at all (no-dead-code rule); its
// settings live in Settings → Token saver (YAN-310), and recorded PXPIPE
// savings still count in the hero total and method breakdown.

/**
 * Token saver page: lime savings hero (YAN-292 aggregation, best non-empty
 * period via useSavingsWithFallback), four method cards with parity
 * controls, experimental PXPIPE row. Period is shared through the URL +
 * localStorage (usePeriod). Every field writes through /api/settings — the
 * same store the Settings page uses.
 */
export default function TokenSaverPageClient() {
  const { period, setPeriod } = usePeriod();
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = useCallback(() => setRefreshKey((value) => value + 1), []);

  const {
    savings,
    loading: savingsLoading,
    error: savingsError,
    fallback,
    neverSaved,
  } = useSavingsWithFallback(period, refreshKey);

  const [settings, setSettings] = useState(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [saveError, setSaveError] = useState("");
  const [savedTick, setSavedTick] = useState(false);
  const savedTimerRef = useRef(null);

  useEffect(
    () => () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    },
    [],
  );

  const [showHeadroomModal, setShowHeadroomModal] = useState(false);

  const [locale, setLocale] = useState("en");

  useEffect(() => {
    setLocale(getCurrentLocale());
    return onLocaleChange(() => setLocale(getCurrentLocale()));
  }, []);

  const isWenyanLocale = WENYAN_LOCALES.includes(locale);
  const visibleCavemanLevels = isWenyanLocale
    ? CAVEMAN_LEVELS
    : CAVEMAN_LEVELS.filter((lvl) => !lvl.wenyan);

  const extras = useHeadroomExtras(bump);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setSettingsLoading(true);
      try {
        const data = await fetchJson("/api/settings");
        if (cancelled) return;
        setSettings(data);
        extras.refresh();
      } catch {
        if (!cancelled) setSettings(null);
      } finally {
        if (!cancelled) setSettingsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const patchSetting = useCallback(async (patch) => {
    setSaveError("");
    try {
      const data = await fetchJson("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setSettings((prev) => ({ ...prev, ...data }));
      setSavedTick(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSavedTick(false), 1500);
      return true;
    } catch (error) {
      setSaveError(error.message);
      return false;
    }
  }, []);

  // Wenyan levels only exist in Chinese locales: fall back when locale changes away.
  const cavemanLevelId = settings?.cavemanLevel;
  useEffect(() => {
    const current = CAVEMAN_LEVELS.find((lvl) => lvl.id === cavemanLevelId);
    if (settings && current?.wenyan && !isWenyanLocale) {
      patchSetting({ cavemanLevel: "ultra" });
    }
  }, [isWenyanLocale, settings, cavemanLevelId, patchSetting]);

  if (settingsLoading) {
    return (
      <div className="flex min-w-0 flex-col gap-5 pb-8">
        <div role="status" aria-label="Loading Token saver">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="mt-4 h-36 w-full" />
          <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="flex min-w-0 flex-col gap-5 pb-8">
        <TokenSaverHeader period={period} onPeriodChange={setPeriod} />
        <Callout variant="err" title="Could not load Token saver">
          Settings failed to load.
          <div className="mt-3">
            <Button variant="secondary" size="sm" icon="refresh" onClick={bump}>
              Retry
            </Button>
          </div>
        </Callout>
      </div>
    );
  }

  const pill = headroomPillProps(extras.headroom);
  const codeExtraOn = settings.headroomCodeAware === true;
  const mlExtraOn = settings.headroomKompress !== false;
  const cavemanDesc = CAVEMAN_LEVELS.find((lvl) => lvl.id === settings.cavemanLevel)?.desc;
  const ponytailDesc = PONYTAIL_LEVELS.find((lvl) => lvl.id === settings.ponytailLevel)?.desc;

  return (
    <div className="flex min-w-0 flex-col gap-5 pb-8">
      <TokenSaverHeader period={period} onPeriodChange={setPeriod} />
      <div aria-live="polite" className="sr-only">
        {savedTick ? "Saved" : ""}
      </div>
      {saveError && (
        <Callout variant="err" title="Could not save">
          {saveError}
        </Callout>
      )}

      <SavingsHero
        savings={savings}
        loading={savingsLoading}
        error={savingsError}
        period={period}
        onRetry={bump}
        fallback={fallback}
        neverSaved={neverSaved}
      />

      <div className="grid min-w-0 grid-cols-1 gap-5 md:grid-cols-2">
        <Card
          title="Compress tool output"
          subtitle="git, grep, ls, tree and log output shrink before they reach the model. 60–90% fewer input tokens."
          icon="terminal"
          action={
            <Toggle
              checked={settings.rtkEnabled !== false}
              onChange={(value) => patchSetting({ rtkEnabled: value })}
              aria-label="Compress tool output"
            />
          }
        >
          <ul className="flex list-none flex-wrap gap-1.5 p-0" aria-label="Compressed output kinds">
            {RTK_CHIPS.map((chip) => (
              <li
                key={chip}
                className="rounded-md border border-line bg-raised px-2 py-1 font-mono text-xs text-muted"
              >
                {chip}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center gap-3 rounded-xl bg-raised p-3 text-[13px]">
            <span className="font-mono">git log · 18.2 KB</span>
            <span className="text-muted" aria-hidden="true">
              →
            </span>
            <span className="font-mono font-semibold text-lime-ink">3.1 KB</span>
            <span className="ms-auto hidden text-muted sm:inline">Illustrative example</span>
          </div>
          <p className="mt-1 text-xs text-muted sm:hidden">Illustrative example</p>
          <MethodFooter
            savings={savings}
            method="rtk"
            tag="RTK"
            offLabel="Errors are never compressed"
          />
        </Card>

        <Card
          title={
            <span className="inline-flex flex-wrap items-center gap-2">
              Compress context
              <HeadroomPill variant={pill.variant} dot={pill.dot} label={pill.label} />
            </span>
          }
          subtitle="Long prompts go through Headroom first, which trims what the model does not need."
          icon="align_horizontal_left"
          action={
            <Toggle
              checked={!!settings.headroomEnabled}
              onChange={(value) => {
                const nextUrl = (settings.headroomUrl || "").trim() || "http://localhost:8787";
                patchSetting({ headroomEnabled: value, headroomUrl: nextUrl });
              }}
              aria-label="Compress context"
            />
          }
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1.6fr_1fr]">
            <Field
              label="Headroom URL"
              hint="Use a local proxy for Start/Stop, or an external sidecar."
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={settings.headroomUrl || "http://localhost:8787"}
                  onChange={(event) =>
                    setSettings((prev) => ({ ...prev, headroomUrl: event.target.value }))
                  }
                  onBlur={async (event) => {
                    const next = event.target.value.trim() || "http://localhost:8787";
                    await patchSetting({ headroomUrl: next });
                    extras.refresh();
                  }}
                  className="font-mono text-[13px]"
                />
              )}
            </Field>
            <Field label="Timeout" hint="Request timeout in milliseconds.">
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={String(settings.headroomTimeoutMs ?? 3000)}
                  onChange={(event) =>
                    setSettings((prev) => ({ ...prev, headroomTimeoutMs: event.target.value }))
                  }
                  onBlur={(event) => {
                    const raw = Math.round(Number(event.target.value));
                    const next = Number.isFinite(raw) && raw > 0 ? raw : 3000;
                    patchSetting({ headroomTimeoutMs: next });
                  }}
                  className="font-mono text-[13px]"
                />
              )}
            </Field>
          </div>
          {extras.headroom.unreachable && (
            <div
              role="alert"
              className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-err"
            >
              <span className="me-auto min-w-0">
                Couldn't reach Headroom at{" "}
                <code className="font-mono" dir="ltr">
                  {settings.headroomUrl || "http://localhost:8787"}
                </code>
                .
              </span>
              <Button variant="secondary" size="sm" icon="refresh" onClick={extras.refresh}>
                Retry
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowHeadroomModal(true)}>
                Manage Headroom
              </Button>
            </div>
          )}
          <HeadroomControls
            headroom={extras.headroom}
            available={extras.available}
            pendingExtras={extras.pendingExtras}
            onTogglePending={extras.togglePending}
            onInstall={extras.install}
            onRemove={extras.remove}
            onToggleActive={extras.toggleActive}
            codeExtraOn={codeExtraOn}
            mlExtraOn={mlExtraOn}
            extrasLoading={extras.extrasLoading}
            extrasError={extras.extrasError}
            removingExtra={extras.removingExtra}
            installLog={extras.installLog}
            restartingProxy={extras.restartingProxy}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="me-1 text-[13px] text-muted">Also user messages</span>
            <Toggle
              size="sm"
              checked={!!settings.headroomCompressUserMessages}
              onChange={(value) => patchSetting({ headroomCompressUserMessages: value })}
              aria-label="Also compress user messages"
            />
            <span className="ms-auto text-xs text-muted">
              {extras.headroom.version ? `Headroom v${extras.headroom.version}` : ""}
            </span>
          </div>
          <MethodFooter
            savings={savings}
            method="headroom"
            tag="Headroom"
            offLabel="Headroom proxy"
            action={
              <Button variant="ghost" size="sm" onClick={() => setShowHeadroomModal(true)}>
                Manage Headroom
              </Button>
            }
          />
        </Card>

        <Card
          title="Compress LLM output"
          subtitle="The model answers like a terse senior engineer. About 65% fewer output tokens."
          icon="chat_bubble"
          action={
            <Toggle
              checked={!!settings.cavemanEnabled}
              onChange={(value) => patchSetting({ cavemanEnabled: value })}
              aria-label="Compress LLM output"
            />
          }
        >
          {settings.cavemanEnabled ? (
            <div className="flex flex-col gap-1">
              <SegmentedControl
                aria-label="Caveman level"
                options={visibleCavemanLevels.map((lvl) => ({
                  value: lvl.id,
                  label: lvl.label,
                }))}
                value={settings.cavemanLevel || "full"}
                onChange={(value) => patchSetting({ cavemanLevel: value })}
              />
              {cavemanDesc && <p className="text-xs text-coral-ink">{cavemanDesc}</p>}
            </div>
          ) : (
            <p className="text-sm text-muted">Off. Turn it on to pick a level.</p>
          )}
          <div className="mt-3 grid grid-cols-1 gap-2.5 text-[13px] leading-relaxed sm:grid-cols-2">
            <div className="rounded-xl bg-raised p-3 text-muted">
              <p className="mb-1 text-xs font-semibold tracking-[0.08em] uppercase">
                Before · illustrative
              </p>
              Sure, happy to help. It looks like the issue is that your function returns before the
              loop has a chance to finish, so…
            </div>
            <div className="rounded-xl bg-lime-bg p-3">
              <p className="mb-1 text-xs font-semibold tracking-[0.08em] text-lime-ink uppercase">
                After · illustrative
              </p>
              Bug: return inside loop. Move it below. Done.
            </div>
          </div>
          <MethodFooter
            savings={savings}
            method="caveman"
            tag="Caveman"
            offLabel="Prompt-only technique: no metered savings"
          />
        </Card>

        <Card
          title="Lazy senior dev"
          subtitle="Nudges the model toward the smallest change that works. Great for “just fix it” sessions."
          icon="code"
          action={
            <Toggle
              checked={!!settings.ponytailEnabled}
              onChange={(value) => patchSetting({ ponytailEnabled: value })}
              aria-label="Lazy senior dev"
            />
          }
        >
          <div className={settings.ponytailEnabled ? "" : "opacity-55"}>
            <SegmentedControl
              aria-label="Ponytail level"
              options={PONYTAIL_LEVELS.map((lvl) => ({ value: lvl.id, label: lvl.label }))}
              value={settings.ponytailLevel || "full"}
              onChange={(value) => patchSetting({ ponytailLevel: value })}
            />
            {settings.ponytailEnabled && ponytailDesc && (
              <p className="mt-1 text-xs text-coral-ink">{ponytailDesc}</p>
            )}
          </div>
          {!settings.ponytailEnabled && (
            <p className="mt-3 rounded-xl border border-dashed border-line p-3 text-[13px] text-muted">
              Off. Turn it on to pick a level.
            </p>
          )}
          <MethodFooter
            savings={savings}
            method="ponytail"
            tag="Ponytail"
            offLabel="Prompt-only technique: no metered savings"
          />
        </Card>
      </div>

      <p className="text-xs text-muted">
        Every field writes through the same settings API as Settings → Token saver. Advanced
        options, including experimental prompts-as-images, live there:{" "}
        <a
          href="/dashboard/settings#token-saver"
          className="font-semibold text-coral-ink underline"
        >
          Open Settings
        </a>
        .
      </p>

      <HeadroomModal
        open={showHeadroomModal}
        onClose={() => setShowHeadroomModal(false)}
        headroom={extras.headroom}
        running={pill.running}
        label={pill.label}
        onRecheck={extras.refresh}
      />
      {extras.confirmDialog}
    </div>
  );
}

TokenSaverPageClient.propTypes = {
  // No props: page-level client owns period, settings, savings and saver state.
};
