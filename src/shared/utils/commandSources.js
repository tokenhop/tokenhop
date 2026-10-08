// Built-in command sources for the palette (YAN-294).
// Each source is (ctx) => commands[]; registrations happen at import time.

import { MEDIA_TABS, visibleItems } from "@/shared/constants/navigation.js";
import {
  AI_PROVIDERS,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
  resolveProviderId,
} from "@/shared/constants/providers.js";
import { GO_TO } from "./goToShortcuts.js";
import { toCommandItems } from "@/app/(dashboard)/dashboard/settings/registry.js";
import { registerStaticSource } from "./commandPalette.js";
import { providerHealth } from "./providerHealth.js";

const CHORD_BY_HREF = Object.fromEntries(
  Object.entries(GO_TO).map(([key, [, href]]) => [href, `g ${key}`]),
);

function providerIdForDetail(providerId) {
  if (typeof providerId !== "string" || !providerId) return null;
  if (isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId)) {
    return providerId;
  }
  const id = resolveProviderId(providerId);
  return AI_PROVIDERS[id] ? id : null;
}

function pageCommands() {
  // ponytail: palette pages remain ungated; APIs enforce caps. Add principal
  // filtering when YAN-373 brings admin pages into the command palette.
  const items = visibleItems();
  const pages = items.map((item) => ({
    id: `page:${item.id}`,
    group: "Pages",
    label: item.label,
    hint: item.href,
    chord: CHORD_BY_HREF[item.href],
    keywords: `${item.id} ${item.href} go to open page`,
    icon: item.icon || "article",
    run: { type: "navigate", href: item.href },
  }));
  for (const tab of MEDIA_TABS) {
    pages.push({
      id: `page:media-${tab.id}`,
      group: "Pages",
      label: `Media ${tab.label}`,
      hint: tab.href,
      keywords: `media ${tab.id} ${tab.label} providers`,
      icon: tab.icon || "perm_media",
      run: { type: "navigate", href: tab.href },
    });
  }
  return pages;
}

function providerCommands({ providers } = {}) {
  const list = Array.isArray(providers) ? providers : [];
  const byProvider = new Map();
  for (const connection of list) {
    const providerId = providerIdForDetail(connection?.provider);
    if (!providerId) continue;
    if (!byProvider.has(providerId)) byProvider.set(providerId, []);
    byProvider.get(providerId).push(connection);
  }
  return [...byProvider.entries()].map(([providerId, entries]) => {
    const health = providerHealth(entries);
    const status = health.reason || (health.connected ? "Healthy" : "Disabled");
    return {
      id: `provider:${providerId}`,
      group: "Providers",
      label: AI_PROVIDERS[providerId]?.name || entries[0]?.name || providerId,
      hint: `${entries.length} account${entries.length === 1 ? "" : "s"} · ${status}`,
      keywords: `provider ${providerId} ${entries
        .map((c) => c.name)
        .filter(Boolean)
        .join(" ")} open`,
      icon: "dns",
      providerId,
      run: { type: "navigate", href: `/dashboard/providers/${providerId}` },
    };
  });
}

function comboCommands({ combos } = {}) {
  const list = Array.isArray(combos) ? combos : [];
  return list.flatMap((combo) => {
    const name = combo?.name || combo?.id;
    if (!name) return [];
    return [
      {
        id: `combo:${combo.id || name}`,
        group: "Combos",
        label: String(name),
        hint: Array.isArray(combo.models) ? combo.models.slice(0, 3).join(", ") : "",
        keywords: `combo fallback ${(combo.models || []).join(" ")}`,
        icon: "layers",
        run: {
          type: "navigate",
          href:
            combo.kind && combo.kind !== "llm"
              ? `/dashboard/media-providers/combo/${encodeURIComponent(combo.id)}`
              : `/dashboard/combos?combo=${encodeURIComponent(combo.id)}`,
        },
      },
    ];
  });
}

function modelCommands({ models } = {}) {
  const list = Array.isArray(models) ? models : [];
  const seen = new Set();
  return list.flatMap((model) => {
    const id = model?.fullModel || model?.routedModel || model?.id;
    // /api/models can repeat an id (custom + builtin overlap).
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const providerId = providerIdForDetail(model.provider);
    return [
      {
        id: `model:${id}`,
        group: "Models",
        label: model.alias && model.alias !== model.model ? `${model.alias}` : String(id),
        hint: String(model.provider || ""),
        keywords: `model ${id} ${model.provider || ""} ${model.model || ""}`,
        icon: "neurology",
        run: { type: "copy", value: id },
        ...(providerId
          ? {
              secondary: {
                label: "Open provider",
                run: { type: "navigate", href: `/dashboard/providers/${providerId}` },
              },
            }
          : {}),
      },
    ];
  });
}

function actionCommands() {
  return [
    {
      id: "action:copy-endpoint",
      group: "Actions",
      label: "Copy endpoint URL",
      hint: "/v1",
      keywords: "copy endpoint url openai base",
      icon: "content_copy",
      run: { type: "copy-endpoint" },
    },
    {
      id: "action:add-provider",
      group: "Actions",
      label: "Add provider",
      hint: "Providers",
      keywords: "add new provider oauth api key connect account",
      icon: "add_circle",
      run: { type: "navigate", href: "/dashboard/providers/new" },
    },
    {
      id: "action:new-combo",
      group: "Actions",
      label: "Create combo",
      hint: "Combos",
      keywords: "create new combo fallback route model builder",
      icon: "layers",
      run: { type: "navigate", href: "/dashboard/combos?create=1" },
    },
    {
      id: "action:new-key",
      group: "Actions",
      label: "Create API key",
      hint: "Endpoint",
      keywords: "new create api key endpoint",
      icon: "add",
      run: { type: "navigate", href: "/dashboard/endpoint?create=key" },
    },
    {
      id: "action:test-providers",
      group: "Actions",
      label: "Test all providers",
      hint: "Providers",
      keywords: "test all providers connections health check",
      icon: "play_arrow",
      run: { type: "verb", verb: "test-providers" },
    },
    {
      id: "action:refresh-quota",
      group: "Actions",
      label: "Refresh quota",
      hint: "Quota",
      keywords: "refresh reload quota usage limits sync",
      icon: "refresh",
      run: { type: "navigate", href: "/dashboard/quota?refresh=1" },
    },
    {
      id: "action:open-request-log",
      group: "Actions",
      label: "Open request log",
      hint: "Usage",
      keywords: "open request log usage history traffic requests",
      icon: "receipt_long",
      run: { type: "navigate", href: "/dashboard/usage?tab=logs" },
    },
    {
      id: "action:toggle-tunnel",
      group: "Actions",
      label: "Cloudflare tunnel",
      hint: "Starts or stops the tunnel",
      keywords: "cloudflare tunnel start stop on off internet expose remote access",
      icon: "cloud",
      run: { type: "verb", verb: "toggle-tunnel" },
    },
    {
      id: "action:clear-console",
      group: "Actions",
      label: "Clear console log",
      hint: "Console log",
      keywords: "clear console log terminal output delete",
      icon: "delete",
      run: { type: "verb", verb: "clear-console" },
    },
    {
      id: "action:change-language",
      group: "Actions",
      label: "Change language",
      hint: "Settings",
      keywords: "change language locale translate display",
      icon: "translate",
      run: { type: "verb", verb: "change-language" },
    },
    {
      id: "action:toggle-theme",
      group: "Actions",
      label: "Toggle theme",
      hint: "Light / dark",
      keywords: "toggle theme dark light appearance",
      icon: "contrast",
      run: { type: "toggle-theme" },
    },
    {
      id: "action:sign-out",
      group: "Actions",
      label: "Sign out",
      hint: "Log out",
      keywords: "sign out logout session end",
      icon: "logout",
      run: { type: "verb", verb: "sign-out" },
    },
    {
      id: "action:open-settings",
      group: "Actions",
      label: "Open Settings",
      hint: "Every knob in one place",
      keywords: "open settings preferences profile",
      icon: "settings",
      run: { type: "navigate", href: "/dashboard/settings" },
    },
  ];
}

registerStaticSource(pageCommands);
registerStaticSource(actionCommands);
registerStaticSource(providerCommands);
registerStaticSource(comboCommands);
registerStaticSource(modelCommands);
registerStaticSource(() => toCommandItems());

export const __test = {
  pageCommands,
  providerCommands,
  comboCommands,
  modelCommands,
  actionCommands,
  settingsCommands: () => toCommandItems(),
};
