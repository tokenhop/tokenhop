import { describe, expect, it } from "vitest";
import { extractFromRepo } from "../../scripts/i18n-literals.mjs";
import { findCopyToneViolations } from "../../scripts/copy-tone.mjs";

/**
 * Literals the §9 detector flags that are correct as written. Every entry
 * needs a reason; anything without one is a regression. Detector false
 * positives (quoted third-party UI labels, button citations, OS role names)
 * belong here — real copy problems get fixed in source instead.
 */
const COPY_TONE_ALLOWLIST = new Map([
  // Windows "run as Administrator" role name keeps its OS casing.
  [
    "Administrator required — restart 9Router as Administrator to use MITM",
    "Windows Administrator role name",
  ],
  // Button/setting citations keep the label's own capitalization.
  [
    "OAuth required. Add now and authenticate after Apply; the tool list will be discovered after the first connect.",
    "cites the Apply button",
  ],
  [
    "Make sure Cursor IDE has been opened at least once, then click Retry. If the problem persists, paste your tokens manually below.",
    "cites the Retry button",
  ],
  ["No accounts connected yet. Click Add account to connect.", "cites the Add account button"],
  [
    "Browser opened. Complete the Xiaomi sign-in, then click Check again.",
    "cites the Check again button",
  ],
  ["Reset to Auto", "cites the Auto select option"],
  ["Reset judge to Auto", "cites the Auto select option"],
  ["Public HTTPS URL. Needs Require API key.", "cites the Require API key setting"],
  ["more providers — open Edit pricing for full details.", "cites the Edit pricing button"],
  ['Click "View All Model" → "Add Custom Model"', "quoted Cursor UI labels"],
  // Third-party UI labels quoted verbatim (VS Code, Claude Desktop, Okta…).
  [
    "Cursor routes requests through its own server, so local endpoint is not supported. Please enable Tunnel or Cloud Endpoint in Settings.",
    "Cursor Tunnel / Cloud Endpoint settings options",
  ],
  [
    "In VS Code, open Extensions (Ctrl+Shift+X or Cmd+Shift+X), search for '9Router for GitHub Copilot' and click Install.",
    "VS Code UI labels and command citations",
  ],
  [
    "Press Cmd+Shift+P (or Ctrl+Shift+P), run '9Router: Configure Server', then enter your server URL and API key:",
    "quoted VS Code command citation",
  ],
  [
    "Open Claude Desktop → Help → Troubleshooting → Enable Developer mode → Configure third-party inference, then return here.",
    "Claude Desktop menu path",
  ],
  [
    "Requires Workers Scripts: Edit permission. Token is used once and not stored.",
    "Cloudflare permission name",
  ],
  [
    "Token is used once for deployment, not stored. Found in Organization Settings.",
    "Vercel Organization Settings label",
  ],
  ["Under Attribute mappings, map", "IdP attribute mappings field label"],
  ["IDC Start URL", "AWS Identity Center field name"],
  // RTK compression level names stay as product labels (also untranslatable).
  ["文 Full", "RTK level name"],
  ["文 Lite", "RTK level name"],
  ["文 Ultra", "RTK level name"],
]);

describe("design-system §9 copy tone (YAN-414 guard)", () => {
  const repoRoot = new URL("../..", import.meta.url).pathname;
  const { literals } = extractFromRepo(repoRoot);
  const violations = findCopyToneViolations(literals);

  it("Title Case violations stay inside the allowlist", () => {
    const flagged = [...new Set(violations.titleCase.map((v) => v.literal))];
    const unexpected = flagged.filter((literal) => !COPY_TONE_ALLOWLIST.has(literal));
    expect(unexpected).toEqual([]);
  });

  it("allowlist entries are all still flagged (no stale entries)", () => {
    const flagged = new Set(violations.titleCase.map((v) => v.literal));
    const stale = [...COPY_TONE_ALLOWLIST.keys()].filter((literal) => !flagged.has(literal));
    expect(stale).toEqual([]);
  });

  it("no exclamation marks outside the one allowed success toast", () => {
    expect(violations.exclamation).toEqual([]);
  });

  it("no emoji in UI copy", () => {
    expect(violations.emoji).toEqual([]);
  });
});
