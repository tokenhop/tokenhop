export const ACCOUNT_STRATEGY_OPTIONS = [
  { value: "fill-first", label: "Fill first — priority order" },
  { value: "round-robin", label: "Round robin — equal rotation" },
  { value: "weighted", label: "Weighted — by plan & remaining quota" },
];

export const OAUTH_STICKY_HINT =
  "Distributes requests by plan capacity × remaining quota. Subscription OAuth accounts default to a sticky limit of 3 — per-request switching between Claude subscription accounts can trigger anti-abuse flags.";

export function formatPlanTier(tier) {
  return tier
    .replace(/^default_claude_/, "")
    .replace(/-tier$/, "")
    .split(/[_-]/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ""))
    .join(" ");
}
