"use client";

import PropTypes from "prop-types";
import { useState } from "react";
import SectionCard from "@/shared/components/SectionCard";
import NumberStepper from "@/shared/components/NumberStepper";
import UnitInput from "@/shared/components/UnitInput";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import { ConfirmDialog } from "@/shared/components/Modal";
import { useSettingsField } from "../useSettingsField";
import {
  COOLDOWN_FIELDS,
  RELIABILITY_KEYS,
  RELIABILITY_UI_DEFAULTS,
  RETRY_ROW_META,
  TIMEOUT_FIELDS,
  formatMs,
  mergeLeaf,
  patchAllReliability,
} from "./reliabilityHelpers";

function FieldError({ error }) {
  if (!error) return null;
  return (
    <p className="py-2 text-xs text-err" role="alert">
      {error}
    </p>
  );
}

FieldError.propTypes = { error: PropTypes.string };

const toNumber = (raw) => {
  if (raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

function Group({ title, description, children, error }) {
  return (
    <div className="py-4 first:pt-0">
      <p className="text-[15px] font-semibold text-text">{title}</p>
      {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      <div className="mt-3">{children}</div>
      <FieldError error={error} />
    </div>
  );
}

Group.propTypes = {
  title: PropTypes.node.isRequired,
  description: PropTypes.node,
  children: PropTypes.node,
  error: PropTypes.string,
};

/**
 * Reliability section (YAN-311): retries per upstream status, cooldowns,
 * backoff and stream timeouts. Each group saves its whole object key (atomic
 * server-side merge). Changes apply to the next request without restart.
 * Stream timeouts set by an env var render read-only with ".env overrides".
 */
export default function ReliabilitySection({ settings, onSettingsChange }) {
  const onSaved = (key) => (value) => onSettingsChange?.({ [key]: value });
  const retry = useSettingsField(
    "retryPolicy",
    settings.retryPolicy ?? RELIABILITY_UI_DEFAULTS.retryPolicy,
    { debounced: true, onSaved: onSaved("retryPolicy") },
  );
  const cooldowns = useSettingsField(
    "cooldowns",
    settings.cooldowns ?? RELIABILITY_UI_DEFAULTS.cooldowns,
    { debounced: true, onSaved: onSaved("cooldowns") },
  );
  const backoff = useSettingsField("backoff", settings.backoff ?? RELIABILITY_UI_DEFAULTS.backoff, {
    debounced: true,
    onSaved: onSaved("backoff"),
  });
  const timeouts = useSettingsField(
    "streamTimeouts",
    settings.streamTimeouts ?? RELIABILITY_UI_DEFAULTS.streamTimeouts,
    { debounced: true, onSaved: onSaved("streamTimeouts") },
  );
  const envOverrides = settings.streamEnvOverrides ?? {};
  const [resetOpen, setResetOpen] = useState(false);

  const setLeaf = (field, path, value) => {
    if (value === undefined) return;
    field.set(mergeLeaf(field.value, path, value));
  };

  // Restore defaults: one PATCH with all four keys — atomic, never half-applied.
  const [resetError, setResetError] = useState("");
  const restoreDefaults = async () => {
    setResetError("");
    try {
      const data = await patchAllReliability();
      for (const key of RELIABILITY_KEYS) {
        onSettingsChange?.({ [key]: data[key] ?? RELIABILITY_UI_DEFAULTS[key] });
      }
      setResetOpen(false);
    } catch (err) {
      setResetError(err.message);
      throw err;
    }
  };

  return (
    <div id="reliability" className="scroll-mt-24 space-y-4">
      <SectionCard
        icon="restart_alt"
        title={
          <span className="inline-flex items-center gap-2">
            Reliability
            <Badge variant="live" size="sm">
              New
            </Badge>
          </span>
        }
        subtitle="Retries, cooldowns and timeouts. Changes apply to the next request, no restart."
      />
      <div className="divide-y divide-line rounded-2xl border border-line bg-panel p-5 shadow-card">
        <Group
          title="Retries on upstream errors"
          description="429s never retry. They cool the account down and fall back."
          error={retry.error}
        >
          <div className="overflow-hidden rounded-xl border border-line text-[13px]">
            <div
              aria-hidden="true"
              className="hidden grid-cols-[minmax(0,1.4fr)_minmax(11rem,1fr)_minmax(0,1fr)] gap-2 bg-raised px-3 py-2 text-xs font-semibold text-muted min-[420px]:grid"
            >
              <span>Status</span>
              <span>Tries</span>
              <span>Delay</span>
            </div>
            {RETRY_ROW_META.map(({ status, label }) => (
              <div
                key={status}
                className="grid grid-cols-1 gap-2 border-t border-line px-3 py-3 first:border-t-0 min-[420px]:grid-cols-[minmax(0,1.4fr)_minmax(11rem,1fr)_minmax(0,1fr)] min-[420px]:items-center min-[420px]:gap-2 min-[420px]:py-2"
              >
                <p className="font-normal">
                  <span className="font-mono">{status}</span>{" "}
                  <span className="text-muted">{label}</span>
                </p>
                <div className="flex items-center gap-2">
                  <span className="w-12 text-xs font-semibold text-muted min-[420px]:hidden">
                    Tries
                  </span>
                  <NumberStepper
                    value={
                      retry.value?.[status]?.tries ??
                      RELIABILITY_UI_DEFAULTS.retryPolicy[status].tries
                    }
                    onChange={(next) => setLeaf(retry, [status, "tries"], next)}
                    min={0}
                    max={10}
                    aria-label={`${status} tries`}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-12 text-xs font-semibold text-muted min-[420px]:hidden">
                    Delay
                  </span>
                  <div className="min-w-0 flex-1">
                    <UnitInput
                      value={
                        retry.value?.[status]?.delayMs ??
                        RELIABILITY_UI_DEFAULTS.retryPolicy[status].delayMs
                      }
                      onChange={(e) =>
                        setLeaf(retry, [status, "delayMs"], toNumber(e.target.value))
                      }
                      unit="ms"
                      min={0}
                      max={60000}
                      aria-label={`${status} delay in milliseconds`}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Group>

        <Group
          title="Cooldowns"
          description="How long an account sits out after it fails."
          error={cooldowns.error}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {COOLDOWN_FIELDS.map(({ key, label }) => (
              <UnitInput
                key={key}
                label={label}
                value={cooldowns.value?.[key] ?? RELIABILITY_UI_DEFAULTS.cooldowns[key]}
                onChange={(e) => setLeaf(cooldowns, [key], toNumber(e.target.value))}
                unit="ms"
                hint={`Default ${formatMs(RELIABILITY_UI_DEFAULTS.cooldowns[key])}`}
              />
            ))}
          </div>
        </Group>

        <Group
          title="Backoff"
          description="Grows with each repeated failure."
          error={backoff.error}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <UnitInput
              label="Start"
              value={backoff.value?.startMs ?? RELIABILITY_UI_DEFAULTS.backoff.startMs}
              onChange={(e) => setLeaf(backoff, ["startMs"], toNumber(e.target.value))}
              unit="ms"
              hint={`Default ${formatMs(RELIABILITY_UI_DEFAULTS.backoff.startMs)}`}
            />
            <UnitInput
              label="Max"
              value={backoff.value?.maxMs ?? RELIABILITY_UI_DEFAULTS.backoff.maxMs}
              onChange={(e) => setLeaf(backoff, ["maxMs"], toNumber(e.target.value))}
              unit="ms"
              hint={`Default ${formatMs(RELIABILITY_UI_DEFAULTS.backoff.maxMs)}`}
            />
            <NumberStepper
              label="Levels"
              value={backoff.value?.levels ?? RELIABILITY_UI_DEFAULTS.backoff.levels}
              onChange={(next) => setLeaf(backoff, ["levels"], next)}
              min={1}
              max={30}
              hint={`Default ${RELIABILITY_UI_DEFAULTS.backoff.levels}`}
            />
          </div>
        </Group>

        <Group
          title="Stream timeouts"
          description="When to give up on a slow or stalled upstream. Env vars win over this setting."
          error={timeouts.error}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {TIMEOUT_FIELDS.map(({ key, label, envVar }) => {
              const overridden = envOverrides[key] === true;
              return (
                <UnitInput
                  key={key}
                  label={
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      {label}
                      {overridden && (
                        <Badge variant="neutral" size="sm">
                          .env overrides
                        </Badge>
                      )}
                    </span>
                  }
                  value={timeouts.value?.[key] ?? RELIABILITY_UI_DEFAULTS.streamTimeouts[key]}
                  onChange={(e) => setLeaf(timeouts, [key], toNumber(e.target.value))}
                  unit="ms"
                  disabled={overridden}
                  hint={
                    overridden
                      ? `Set by ${envVar} in .env. Read-only here.`
                      : `Default ${formatMs(RELIABILITY_UI_DEFAULTS.streamTimeouts[key])}`
                  }
                />
              );
            })}
          </div>
        </Group>

        <div className="pt-4">
          <Button variant="secondary" icon="restart_alt" onClick={() => setResetOpen(true)}>
            Restore defaults
          </Button>
        </div>
      </div>
      <ConfirmDialog
        isOpen={resetOpen}
        onClose={() => {
          setResetOpen(false);
          setResetError("");
        }}
        onConfirm={restoreDefaults}
        title="Restore reliability defaults?"
        message="Retries, cooldowns, backoff and stream timeouts go back to the built-in values."
        confirmText="Restore defaults"
        error={resetError || undefined}
        variant="primary"
      />
    </div>
  );
}

ReliabilitySection.propTypes = {
  settings: PropTypes.object.isRequired,
  onSettingsChange: PropTypes.func,
};
