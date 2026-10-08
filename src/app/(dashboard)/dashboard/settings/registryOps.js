/** Settings registry — providers through danger zone, in registry order. */
import { ACTIVE } from "@/shared/brand";

export const OPS_SECTIONS = [
  {
    id: "providers",
    title: "Providers & models",
    subtitle: "Defaults that apply across providers.",
    icon: "dns",
    rows: [
      {
        key: "providerThinking",
        label: "Default thinking level",
        description: "Used when a request doesn't ask for one.",
        keywords: "provider thinking level default reasoning",
      },
      {
        key: "claudeAutoPing",
        label: "Auto-ping · Claude Code",
        description: "A tiny request keeps quota windows warm. Per connection only.",
        keywords: "auto ping claude quota warm connections",
      },
      {
        key: "codexAutoPing",
        label: "Auto-ping · Codex",
        description: "A tiny request keeps quota windows warm. Per connection only.",
        keywords: "auto ping codex quota warm connections",
      },
      {
        key: "ccFilterNaming",
        label: "Filter naming requests",
        description: "Drop Claude Code title-naming calls to save quota.",
        keywords: "cc filter naming title claude",
      },
      {
        key: "quotaVisibility",
        label: "Quota rows shown",
        description: "Pick which limits appear on the Quota page.",
        keywords: "quota visibility rows limits shown hide",
      },
      {
        key: "mitmRouterBaseUrl",
        label: "Intercept (MITM) router URL",
        description: "Base URL the MITM server routes through.",
        keywords: "mitm router url intercept base",
      },
    ],
  },
  {
    id: "logs",
    title: "Observability & logs",
    subtitle: "What gets recorded, and for how long.",
    icon: "monitoring",
    rows: [
      {
        key: "enableObservability",
        label: "Record request details",
        description: "Full payloads in Usage → Request log.",
        keywords: "observability record request details log",
      },
      {
        key: "observabilityMaxRecords",
        label: "Max records",
        description: "Stored request details cap.",
        keywords: "observability max records storage limits",
      },
      {
        key: "observabilityBatchSize",
        label: "Batch size",
        description: "Write batch size.",
        keywords: "observability batch size",
      },
      {
        key: "observabilityFlushIntervalMs",
        label: "Flush every",
        description: "Flush interval, in milliseconds.",
        keywords: "observability flush interval ms",
      },
      {
        key: "observabilityMaxJsonSize",
        label: "Max payload size",
        description: "Kilobytes per payload.",
        keywords: "observability max payload size json kb",
      },
      {
        key: "requestLogsEnabled",
        label: "Log every request to console",
        description: "Writes request/response logs under logs/ for debugging.",
        keywords: "log request console debug ENABLE_REQUEST_LOGS env",
        tags: ["env"],
      },
      {
        key: "translatorEnabled",
        label: "Show Translator page",
        description: "Debug tool for format translation.",
        keywords: "translator debug format page ENABLE_TRANSLATOR env",
        tags: ["env"],
      },
    ],
  },
  {
    id: "pricing",
    title: "Pricing",
    subtitle: "What cost estimates use, in $ per 1M tokens.",
    icon: "savings",
    rows: [
      {
        key: "pricingOverview",
        label: "Pricing overview",
        description: "Model count, provider count, custom overrides.",
        keywords: "pricing models providers custom cost overview",
      },
      {
        key: "pricingEdit",
        label: "Edit pricing",
        description: "Override per-model rates.",
        keywords: "edit pricing modal override rates",
      },
      {
        key: "pricingReset",
        label: "Reset to defaults",
        description: "Restore standard rates.",
        keywords: "reset defaults restore pricing",
      },
    ],
  },
  {
    id: "about",
    title: "About",
    subtitle: "Version and project information.",
    icon: "info",
    rows: [
      {
        key: "version",
        label: "Version",
        description: "App version and build channel.",
        keywords: "version build release channel about",
      },
      {
        key: "project",
        label: "Project",
        description: "GitHub, docs and releases.",
        keywords: "project github docs releases links about",
      },
      {
        key: "license",
        label: "License",
        description: "MIT license.",
        keywords: "license mit open source about",
      },
    ],
  },
  {
    id: "data",
    title: "Data & backup",
    subtitle: "Everything lives in one SQLite file.",
    icon: "database",
    rows: [
      {
        key: "databasePath",
        label: "Database",
        description: "SQLite file location.",
        keywords: "database sqlite location path size data dir",
      },
      {
        key: "backup",
        label: "Backup",
        description: "Download or import a password-gated backup.",
        keywords: "backup download import export restore password",
      },
      {
        key: "cloudEnabled",
        label: "Cloud sync",
        description: "Keep settings and connections in sync across machines.",
        keywords: "cloud sync backup remote machines",
        tags: ["new"],
      },
    ],
  },
  {
    id: "environment",
    title: "Environment",
    subtitle: "Read from .env at startup. Edit the file and restart.",
    icon: "terminal",
    rows: [
      {
        key: "PORT",
        label: "Port",
        description: "Read-only server port.",
        keywords: "port env environment server",
        tags: ["env"],
      },
      {
        key: "DATA_DIR",
        label: "Data directory",
        description: "Read-only data directory.",
        keywords: "data dir env environment path",
        tags: ["env"],
      },
      {
        key: "envValues",
        label: "Environment values",
        description: "Read-only allowlisted env values with credentials masked.",
        keywords: "env environment proxy base url cloud searxng timeout",
        tags: ["env"],
      },
    ],
  },
  {
    id: "danger",
    title: "Danger zone",
    subtitle: "End sessions and stop the server.",
    icon: "warning",
    rows: [
      {
        key: "logout",
        label: "Log out",
        description: "End this dashboard session.",
        keywords: "logout sign out session",
      },
      {
        key: "shutdown",
        label: `Shut down ${ACTIVE.slug}`,
        description: "Your tools lose their endpoint until you start it again.",
        keywords: "shutdown stop close server power",
      },
    ],
  },
];
