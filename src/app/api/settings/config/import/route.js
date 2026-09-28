import { NextResponse } from "next/server";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { getSettings } from "@/lib/localDb";
import { resetComboRotation } from "open-sse/services/combo.js";
import { hasValidCliToken } from "@/lib/auth/cliToken";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";
import { validateSettingsBody } from "../../route.js";
import {
  applyConfig,
  exportConfig,
  getConfigState,
  getKnownConfigSettingKeys,
} from "@/lib/db/configExport.js";
import {
  MAX_CONFIG_BYTES,
  SECRET_SETTING_KEYS,
  diffConfig,
  validateConfigDocument,
} from "@/lib/settingsConfigDoc.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PASSWORD_HEADER = "x-9r-password";

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * POST /api/settings/config/import — password-confirmed config import.
 * { doc, mode: "preview" } (default) validates, checks value ranges with the
 * same validators as PATCH /api/settings, and returns the diff without
 * writing. { doc, mode: "apply" } re-validates and applies atomically inside
 * one SQLite transaction (settings, combos, pricing roll back together).
 */
export async function POST(request) {
  let raw = "";
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ error: "Failed to read request body" }, { status: 400 });
  }
  if (raw.length > MAX_CONFIG_BYTES) {
    return NextResponse.json({ error: "Config file too large (max 1 MB)" }, { status: 413 });
  }
  // raw.length counts UTF-16 units, not bytes: multibyte configs understate
  // their real size, so also measure bytes.
  if (Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) {
    return NextResponse.json({ error: "Config file too large (max 1 MB)" }, { status: 413 });
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isPlainObject(body) || body.doc === undefined) {
    return NextResponse.json({ error: "Body must be { doc, mode }" }, { status: 400 });
  }
  const mode = body.mode ?? "preview";
  if (mode !== "preview" && mode !== "apply") {
    return NextResponse.json({ error: 'mode must be "preview" or "apply"' }, { status: 400 });
  }

  try {
    const password = typeof body.password === "string" ? body.password : null;
    if (
      !(await hasValidCliToken(request)) &&
      !(await verifyDashboardPassword(password ?? request.headers.get(PASSWORD_HEADER)))
    ) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }

    // Copy through JSON so "__proto__" arrives as an own key, which the
    // validators check for explicitly.
    const parsed = JSON.parse(JSON.stringify(body.doc));
    const knownKeys = await getKnownConfigSettingKeys();
    const checked = validateConfigDocument(parsed, knownKeys);
    if (!checked.valid) {
      return NextResponse.json(
        { error: checked.errors[0], errors: checked.errors, warnings: checked.warnings },
        { status: 400 },
      );
    }

    // An import must never store what the settings UI could not save: run the
    // same boundary validators as PATCH /api/settings.
    const settingsError = validateSettingsBody(checked.doc.settings);
    if (settingsError) {
      return NextResponse.json(
        { error: settingsError, errors: [settingsError], warnings: checked.warnings },
        { status: 400 },
      );
    }

    // Belt and suspenders: secrets are validated out above, and stripped again
    // here so a future validator change can never persist one (CWE-915).
    for (const secret of SECRET_SETTING_KEYS) delete checked.doc.settings[secret];

    // Combos reference each other by name like the Combos page does: reject a
    // cycle the same way POST/PUT /api/combos would.
    const { findComboCycle } = await import("open-sse/services/combo.js");
    const baseState = await getConfigState();
    const mergedCombos = new Map(baseState.combos.map((c) => [c.name, c.models ?? []]));
    for (const combo of checked.doc.combos) mergedCombos.set(combo.name, combo.models ?? []);
    for (const combo of checked.doc.combos) {
      const others = [...mergedCombos.entries()]
        .filter(([name]) => name !== combo.name)
        .map(([name, models]) => ({ name, models }));
      const cycle = findComboCycle(combo.name, combo.models ?? [], others);
      if (cycle) {
        return NextResponse.json(
          { error: `Combo cycle detected: ${cycle.join(" → ")}` },
          { status: 400 },
        );
      }
    }

    if (mode === "preview") {
      const diff = diffConfig(checked.doc, await getConfigState());
      return NextResponse.json({
        valid: true,
        warnings: checked.warnings,
        redactedSettings: checked.redactedSettings,
        diff,
        restartRequired: diff.restartRequired,
      });
    }

    const { restartRequired } = await applyConfig(checked.doc);

    // Re-apply side effects the same way PATCH /api/settings does.
    const appliedSettings = await getSettings();
    try {
      applyOutboundProxyEnv(appliedSettings);
    } catch (err) {
      console.warn("[Settings][ConfigImport] Failed to re-apply outbound proxy env:", err);
    }
    resetComboRotation();
    if (
      Object.hasOwn(checked.doc.settings, "fallbackStrategy") ||
      Object.hasOwn(checked.doc.settings, "stickyRoundRobinLimit") ||
      Object.hasOwn(checked.doc.settings, "providerStrategies")
    ) {
      import("@/sse/services/auth")
        .then(({ resetAccountSelection }) => resetAccountSelection?.())
        .catch((error) => console.warn("[AccountSelection] reset failed:", error.message));
    }
    if (
      Object.hasOwn(checked.doc.settings, "claudeAutoPing") ||
      Object.hasOwn(checked.doc.settings, "codexAutoPing")
    ) {
      import("@/shared/services/quotaAutoPing")
        .then(({ configureQuotaAutoPing }) => configureQuotaAutoPing(appliedSettings))
        .catch((error) => console.warn("[AutoPing] settings update failed:", error.message));
    }
    import("@/shared/services/quotaSnapshotPoller")
      .then(({ syncQuotaSnapshotPoller }) => syncQuotaSnapshotPoller())
      .catch((error) =>
        console.warn("[Settings][ConfigImport] quota poller sync failed:", error?.message),
      );

    const after = diffConfig(checked.doc, await getConfigState());
    return NextResponse.json({
      valid: true,
      warnings: checked.warnings,
      redactedSettings: checked.redactedSettings,
      diff: after,
      restartRequired: restartRequired || after.restartRequired,
      exportedAt: (await exportConfig()).exportedAt,
    });
  } catch (error) {
    console.log("Error importing config:", error);
    // Validation and transaction failures are 400s; anything else (a bug, a
    // down DB) is a 500 without leaking internals. The transaction wrapper is
    // the only in-function throw, so its message reaching here means the
    // apply rolled back.
    const message = error?.message || "Failed to import config";
    const isImportError =
      message.startsWith("Invalid ") ||
      message.startsWith("Refused ") ||
      message.includes("Combo ") ||
      message.includes("cycle") ||
      message.includes("pricing") ||
      message.includes("Too many") ||
      message.includes("Duplicate") ||
      message.includes("must be") ||
      message.includes("required");
    return NextResponse.json(
      { error: isImportError ? message : "Failed to import config" },
      { status: isImportError ? 400 : 500 },
    );
  }
}
