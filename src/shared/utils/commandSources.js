// Built-in command sources for the palette (YAN-294).
// Each source is (ctx) => commands[]; registrations happen at import time.

import { MEDIA_TABS, visibleItems } from "@/shared/constants/navigation.js";
import { toCommandItems } from "@/app/(dashboard)/dashboard/settings/registry.js";
import { registerStaticSource } from "./commandPalette.js";
import { connectionHealth } from "./providerHealth.js";

function pageCommands() {
  const items = visibleItems();
  const pages = items.map((item) => ({
    id: `page:${item.id}`,
    group: "Pages",
    label: item.label,
    hint: item.href,
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
  return list.flatMap((connection) => {
    const name = connection?.name || connection?.provider || connection?.id;
    if (!name) return [];
    const health = connectionHealth(connection);
    const healthHint = health.reason || "Healthy";
    return [
      {
        id: `provider:${connection.id || name}`,
        group: "Providers",
        label: String(name),
        // Keep the provider identity first so YAN-390's ⌘K fix keeps working;
        // the shared health rule adds status context after it.
        hint: `${connection?.provider ? String(connection.provider) : ""} · ${healthHint}`,
        keywords: `provider ${connection?.provider || ""} ${connection?.id || ""} open`,
        icon: "dns",
        run: {
          type: "navigate",
          href: `/dashboard/providers${connection.id ? `/${connection.id}` : ""}`,
        },
      },
    ];
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
        run: { type: "navigate", href: "/dashboard/combos" },
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
    return [
      {
        id: `model:${id}`,
        group: "Models",
        label: model.alias && model.alias !== model.model ? `${model.alias}` : String(id),
        hint: String(model.provider || ""),
        keywords: `model ${id} ${model.provider || ""} ${model.model || ""}`,
        icon: "neurology",
        run: { type: "navigate", href: "/dashboard/endpoint" },
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
      id: "action:new-key",
      group: "Actions",
      label: "Create API key",
      hint: "Endpoint",
      keywords: "new create api key endpoint",
      icon: "add",
      run: { type: "navigate", href: "/dashboard/endpoint" },
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
