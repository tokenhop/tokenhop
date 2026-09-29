#!/usr/bin/env node
/**
 * Dev-only demo of the quota runway forecast states (YAN-401).
 *
 *   node scripts/quota-forecast-demo.mjs [--out /tmp/quota-forecast-fixture.json]
 *
 * Feeds simulated samples through the real forecast store and prints the
 * resulting forecast per state. `--out` also writes a fixture with
 * `/api/usage/<id>` and `/api/home/quota` bodies, for mocking those routes in a
 * browser (e.g. Playwright `page.route`) to review every state in the UI.
 * Touches no data dir, database or provider.
 */
import { writeFileSync } from "node:fs";
import {
  _resetQuotaForecastStore,
  getQuotaForecasts,
  pickUrgentForecast,
  recordQuotaSample,
} from "../src/lib/quota/forecastStore.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const now = Date.now();

// quota key → [start remaining %, burn %/h, reset in ms, sample count]
const SCENARIOS = {
  "session (5h)": [60, 20, 4 * HOUR, 12], // will-run-out (~3h to empty)
  "weekly (7d)": [41, 1, 38 * HOUR, 12], // tight (~40h to empty vs 38h reset)
  "weekly sonnet (7d)": [80, 1, 24 * HOUR, 12], // on-track
  "weekly opus (7d)": [90, 0, 24 * HOUR, 12], // idle
  "weekly fable (7d)": [70, 5, 24 * HOUR, 2], // unknown: insufficient data
};

_resetQuotaForecastStore();
const quotas = {};
for (const [key, [start, burn, resetIn, count]] of Object.entries(SCENARIOS)) {
  const resetAt = new Date(now + resetIn).toISOString();
  const stepMs = 5 * MIN;
  for (let i = 0; i < count; i++) {
    const t = now - (count - 1 - i) * stepMs;
    const remaining = start - (burn * (t - (now - (count - 1) * stepMs))) / HOUR;
    recordQuotaSample("demo", key, { remaining, resetAt }, t);
  }
  const remaining = Math.round(start - (burn * (count - 1) * stepMs) / HOUR);
  quotas[key] = {
    used: 100 - remaining,
    total: 100,
    remaining,
    remainingPercentage: remaining,
    resetAt,
    unlimited: false,
  };
}

const forecasts = getQuotaForecasts("demo", now);
for (const [key, f] of Object.entries(forecasts)) {
  const burn = f.burnPctPerHour === null ? "-" : `${f.burnPctPerHour.toFixed(1)}%/h`;
  console.log(`${key.padEnd(20)} ${f.state.padEnd(13)} ${f.reason ?? ""} burn=${burn}`);
}

const outIndex = process.argv.indexOf("--out");
if (outIndex !== -1) {
  const file = process.argv[outIndex + 1];
  if (!file) throw new Error("--out needs a file path");
  const fixture = {
    usage: { plan: "demo", quotas, forecasts },
    homeAccount: { forecast: pickUrgentForecast(forecasts) },
  };
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`fixture written to ${file}`);
}
