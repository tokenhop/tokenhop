/**
 * Settings section registry: the single source of truth for the
 * `/dashboard/settings` page shell. Each section declares its id, title,
 * subtitle, icon and rows (key, label, description, keywords, tags). The
 * registry drives rendering, the anchor nav, search, and the command-palette
 * registration (YAN-294 — no palette exists yet, so `toCommandItems` exports
 * the items ready to plug in).
 *
 * Rows are metadata only; interactive controls live in the section components.
 * Section data lives in registryCore.js (general..token-saver) and
 * registryOps.js (providers..danger).
 */
import { CORE_SECTIONS } from "./registryCore";
import { OPS_SECTIONS } from "./registryOps";

/**
 * @typedef {object} SettingsRow
 * @property {string} key Stored settings key (or pseudo-key for actions).
 * @property {string} label Row label shown in the UI.
 * @property {string} [description] Short explainer.
 * @property {string} [keywords] Extra search terms (space-separated).
 * @property {Array<"new"|"env"|"experimental">} [tags] Board tags.
 */

/**
 * @typedef {object} SettingsSection
 * @property {string} id Anchor id.
 * @property {string} title Section title.
 * @property {string} subtitle Section subtitle.
 * @property {string} icon Material Symbols Outlined icon name.
 * @property {string} [statusPill] Optional status pill label.
 * @property {SettingsRow[]} rows Searchable rows in this section.
 */

/** @type {SettingsSection[]} */
export const SETTINGS_SECTIONS = [...CORE_SECTIONS, ...OPS_SECTIONS];

export const SETTINGS_GROUPS = [
  {
    id: "account",
    title: "Account",
    icon: "manage_accounts",
    sections: ["general", "security", "sso"],
  },
  {
    id: "traffic",
    title: "Traffic",
    icon: "route",
    sections: ["routing", "reliability", "network", "token-saver"],
  },
  {
    id: "models",
    title: "Models & usage",
    icon: "dns",
    sections: ["providers", "logs", "pricing"],
  },
  {
    id: "system",
    title: "System",
    icon: "settings",
    sections: ["about", "data", "environment", "danger"],
  },
];

/** Anchor nav entries in section order: [{ id, title }]. */
export const SETTINGS_ANCHORS = SETTINGS_SECTIONS.map(({ id, title }) => ({ id, title }));

/**
 * Section anchors in registry order.
 * @returns {Array<{ id: string, title: string }>}
 */
export function sectionAnchors() {
  return SETTINGS_ANCHORS.map((anchor) => ({ ...anchor }));
}

function rowMatches(row, query) {
  const haystack =
    `${row.key} ${row.label} ${row.description ?? ""} ${row.keywords ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/**
 * Filter registry rows by label, description, key and keywords.
 * Empty query returns every section untouched.
 * @param {string} query Search text.
 * @param {SettingsSection[]} [sections] Sections to search; defaults to the full registry.
 * @returns {SettingsSection[]} Sections with at least one matching row.
 */
export function filterRows(query, sections = SETTINGS_SECTIONS) {
  if (!query?.trim()) return sections;
  return sections
    .map((section) => ({
      ...section,
      rows: section.rows.filter((row) => rowMatches(row, query)),
    }))
    .filter((section) => section.rows.length > 0);
}

/**
 * Command-palette items for every registry row, ready to register with the
 * YAN-294 palette when it lands.
 * @returns {Array<{ id: string, label: string, hint: string, href: string }>}
 */
export function toCommandItems() {
  return SETTINGS_SECTIONS.flatMap((section) =>
    section.rows.map((row) => ({
      id: `settings:${row.key}`,
      group: "Settings",
      label: `${section.title} — ${row.label}`,
      hint: row.description || "",
      keywords: `${section.title} ${row.label} ${row.description || ""} ${row.keywords || ""}`,
      icon: section.icon || "settings",
      href: `/dashboard/settings#${section.id}`,
      run: { type: "navigate", href: `/dashboard/settings#${section.id}` },
    })),
  );
}
