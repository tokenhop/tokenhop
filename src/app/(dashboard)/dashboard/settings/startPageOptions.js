// Start-page dropdown: labels for the canonical allowlist in
// src/lib/settingsFlags.js (server validation is authoritative).

import { START_PAGE_ALLOWLIST_VALUES } from "@/lib/settingsFlags";

const START_PAGE_LABELS = {
  "/dashboard": "Home",
  "/dashboard/providers": "Providers",
  "/dashboard/combos": "Combos",
  "/dashboard/endpoint": "Endpoint & keys",
  "/dashboard/usage": "Usage",
  "/dashboard/quota": "Quota",
  "/dashboard/console-log": "Console log",
  "/dashboard/token-saver": "Token saver",
  "/dashboard/cli-tools": "CLI tools",
  "/dashboard/media-providers": "Media providers",
  "/dashboard/proxy-pools": "Proxy pools",
  "/dashboard/skills": "Skills",
  "/dashboard/settings": "Settings",
  "/dashboard/translator": "Translator",
};

export const START_PAGE_OPTIONS = START_PAGE_ALLOWLIST_VALUES.map((value) => ({
  value,
  label: START_PAGE_LABELS[value] || value,
}));
