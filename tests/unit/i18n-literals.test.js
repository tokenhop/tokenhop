import { describe, expect, it } from "vitest";
import {
  UNTRANSLATED_RE,
  diffAgainstLocales,
  extractFromSource,
  placeholdersOf,
  readLocaleFiles,
  validateLocaleFile,
} from "../../scripts/i18n-literals.mjs";
import { REPR_RE, isVerbatim, validateTranslation } from "../../scripts/translate-literals.mjs";

describe("extractFromSource", () => {
  it("extracts plain JSX text", () => {
    expect([...extractFromSource(`<p>Hello world</p>`, "a.js")]).toEqual(["Hello world"]);
  });

  it("extracts aria-label, placeholder, title and alt string literals", () => {
    const got = [
      ...extractFromSource(
        `<button aria-label="Close dialog" title="More info"><img alt="Logo" /><input placeholder="Search models..." /></button>`,
        "a.js",
      ),
    ];
    expect(got).toEqual(["Close dialog", "More info", "Logo", "Search models..."]);
  });

  it("extracts translate() string arguments", () => {
    expect([...extractFromSource(`const a = translate("No models returned");`, "a.js")]).toEqual([
      "No models returned",
    ]);
  });

  it("skips icon ligatures, code tags and data-i18n-skip subtrees", () => {
    const got = [
      ...extractFromSource(
        `<div><span aria-hidden="true" className="material-symbols-outlined">search</span><code>const x = 1</code><div data-i18n-skip="true"><p>Skipped</p></div><p>Kept</p></div>`,
        "a.js",
      ),
    ];
    expect(got).toEqual(["Kept"]);
  });

  it("skips dynamic translate() arguments", () => {
    expect([...extractFromSource(`const a = translate(variable);`, "a.js")]).toEqual([]);
    expect([...extractFromSource("const a = translate(`Hi ${name}`);", "a.js")]).toEqual([]);
  });

  it("skips pure punctuation and single characters", () => {
    expect([...extractFromSource(`<span>…</span><span>:</span>`, "a.js")]).toEqual([]);
  });

  it("skips URLs and mono identifiers that must not be translated", () => {
    const code = `<><code>sk_abc</code><span>https://example.com/sse</span><span>chevron_right</span><span>verbose_json</span><span>http://localhost:8787</span><span>localhost, 127.0.0.1</span><span>Save changes</span></>`;
    expect([...extractFromSource(code, "a.js")]).toEqual(["Save changes"]);
  });

  it("extracts loading-style literals ending in an ellipsis", () => {
    expect([...extractFromSource(`<p>Loading...</p>`, "a.js")]).toEqual(["Loading..."]);
  });

  it("extracts component props that render as DOM text", () => {
    const got = [
      ...extractFromSource(
        `<><Field label="Base URL" hint="Same behavior as MITM" /><SetupScaffold installHint="Run droid to verify" /><EmptyState emptyTitle="No pools yet" emptyBody="Create one" /></>`,
        "a.js",
      ),
    ];
    expect(got).toEqual([
      "Base URL",
      "Same behavior as MITM",
      "Run droid to verify",
      "No pools yet",
      "Create one",
    ]);
  });

  it("ignores non-text props on components", () => {
    expect([
      ...extractFromSource(`<Field name="url" copyValue="abc" installCommand="npm i" />`, "a.js"),
    ]).toEqual([]);
  });

  it("extracts option text shown as the selected label", () => {
    expect([...extractFromSource(`<select><option>Auto-detect</option></select>`, "a.js")]).toEqual(
      ["Auto-detect"],
    );
  });

  it("extracts label keys from navigation constants only", () => {
    const code = `export const NAV = [{ id: "home", label: "Endpoint & keys" }];`;
    expect([...extractFromSource(code, "src/shared/constants/navigation.js")]).toEqual([
      "Endpoint & keys",
    ]);
    expect([...extractFromSource(code, "src/app/page.js")]).toEqual([]);
  });

  it("extracts UI object literals in dashboard modules, not API routes or ids", () => {
    const code = `export const SECTIONS = [
  { id: "oauth", title: "Subscriptions & OAuth", subtitle: "Sign in once." },
  { icon: "public", title: "Access Anywhere", desc: "Use your API from any network" },
  { toast: { message: "Settings saved" } },
  { id: "openai", name: "gpt-4", url: "https://example.com/models" },
];`;
    expect([
      ...extractFromSource(code, "src/app/(dashboard)/dashboard/providers/sections.js"),
    ]).toEqual([
      "Subscriptions & OAuth",
      "Sign in once.",
      "Access Anywhere",
      "Use your API from any network",
      "Settings saved",
    ]);
    expect([...extractFromSource(code, "src/app/api/x/route.js")]).toEqual([]);
  });

  it("returns empty on unparsable input", () => {
    expect([...extractFromSource(`<div><span>`, "a.js")]).toEqual([]);
  });
});

describe("placeholdersOf", () => {
  it("finds brace, printf and bracket tokens", () => {
    expect(placeholdersOf("Saved {count} items")).toEqual(["{count}"]);
    expect(placeholdersOf("Hello %s")).toEqual(["%s"]);
    expect(placeholdersOf("Install [code] now")).toEqual(["[code]"]);
  });

  it("ignores ordinary prose", () => {
    expect(placeholdersOf("No accounts found")).toEqual([]);
  });
});

describe("UNTRANSLATED_RE", () => {
  it("matches product names and identifiers", () => {
    for (const value of ["9Router", "9Remote", "RTK", "PXPIPE", "MCP", "cli/models"]) {
      expect(UNTRANSLATED_RE.test(value)).toBe(true);
    }
  });

  it("does not match prose needing translation", () => {
    for (const value of ["Close dialog", "No models returned", "Failed to save proxy pool"]) {
      expect(UNTRANSLATED_RE.test(value)).toBe(false);
    }
  });
});

describe("verbatim glossary", () => {
  // Mirrors VERBATIM in scripts/translate-literals.py: product, protocol, API
  // and language names that stay English in every locale. Only these entries
  // may be stored with value == key; everything else must be translated.
  it("pins product/protocol names (new translations keep these literal)", () => {
    const expected = [
      "9English",
      "AWS Builder ID",
      "AWS IAM Identity Center",
      "Browser MCP",
      "CLIProxyAPI Auth JSON",
      "Claude CLI",
      "Claude Code",
      "Cloudflare Tunnel",
      "Cloudflare Workers AI",
      "Codex CLI",
      "DNS",
      "Exa",
      "GitHub",
      "ID",
      "JSON (Base64)",
      "Keycloak / Authentik",
      "MP3 (Binary)",
      "Microsoft Entra ID (Azure AD)",
      "NPM",
      "OAuth",
      "Okta / Auth0",
      "OpenAI Codex",
      "OpenAI Codex CLI",
      "OIDC",
      "SAML 2.0",
      "cURL",
      "Tailscale",
      "Tailscale Funnel",
      "Tavily",
      "Twitter",
      "UID:",
      "Voyage AI",
      "no_proxy:",
      "voyage",
    ];
    const locales = readLocaleFiles(
      new URL("../../public/i18n/literals", import.meta.url).pathname,
    );
    const stable = [
      "9English",
      "GitHub",
      "OAuth",
      "NPM",
      "Exa",
      "Tavily",
      "Voyage AI",
      "DNS",
      "OIDC",
      "Python",
      "cURL",
      "SAML 2.0",
      "Claude CLI",
      "Claude Code",
      "Codex CLI",
      "OpenAI Codex",
    ];
    for (const [locale, map] of locales) {
      for (const key of stable) {
        if (key in map) expect(map[key], `${locale}: ${key}`).toBe(key);
      }
    }
    expect(expected).toContain("AWS IAM Identity Center");
    expect(expected).not.toContain("Menu");
  });
});

describe("translate-literals validation", () => {
  it("rejects repr garbage, echoes, placeholder drift and brand loss", () => {
    expect(validateTranslation("Save", "{'text': 'Speichern'}")).toBe("repr-garbage");
    expect(validateTranslation("Save changes", "Save changes")).toBe("echo");
    expect(validateTranslation("Saved {count} items", "Gespeichert")).toBe("placeholder-drift");
    expect(validateTranslation("Add Anthropic", "Menschlich hinzufügen")).toMatch(/^brand-loss/);
    expect(validateTranslation("Save changes", "Änderungen speichern")).toBeNull();
  });

  it("allows only glossary, identifier and slug values to stay English", () => {
    expect(isVerbatim("OAuth")).toBe(true);
    expect(isVerbatim("my-combo")).toBe(true);
    expect(isVerbatim("cc/claude-opus-4-7")).toBe(true);
    expect(isVerbatim("Auto-scroll")).toBe(false);
    expect(isVerbatim("Menu")).toBe(false);
  });
});

describe("diffAgainstLocales", () => {
  const locales = new Map([
    ["de", { Hello: "Hallo", "Bye {count}": "Tschüss {count}" }],
    ["fr", { Hello: "Bonjour" }],
  ]);

  it("reports missing keys per locale", () => {
    const { missing } = diffAgainstLocales(["Hello", "New string"], locales);
    expect(missing).toEqual({ de: ["New string"], fr: ["New string"] });
  });

  it("reports orphaned keys absent from the source", () => {
    const { orphaned } = diffAgainstLocales(["Hello"], locales);
    expect(orphaned).toEqual(["Bye {count}"]);
  });

  it("reports placeholder drift between source and translation", () => {
    const bad = new Map([["de", { "Bye {count}": "Tschüss" }]]);
    const { mismatches } = diffAgainstLocales(["Bye {count}"], bad);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ locale: "de", key: "Bye {count}" });
  });

  it("reports no mismatch when placeholders agree", () => {
    const { mismatches } = diffAgainstLocales(["Bye {count}"], locales);
    expect(mismatches).toHaveLength(0);
  });
});

describe("validateLocaleFile", () => {
  it("flags empty translations", () => {
    expect(validateLocaleFile({ Hello: "   ", Bye: "Tschüss" }).empty).toEqual(["Hello"]);
  });

  it("flags placeholder drift inside a locale file", () => {
    expect(validateLocaleFile({ "Bye {count}": "Tschüss" }).mismatched).toEqual(["Bye {count}"]);
  });
});

describe("locale files on disk", () => {
  const locales = readLocaleFiles(new URL("../../public/i18n/literals", import.meta.url).pathname);

  it("each file parses as a JSON object", () => {
    expect(locales.size).toBeGreaterThan(0);
    for (const map of locales.values()) {
      expect(typeof map).toBe("object");
    }
  });

  it("has no empty strings and no placeholder mismatches", () => {
    const problems = [];
    for (const [locale, map] of locales) {
      const { empty, mismatched } = validateLocaleFile(map);
      for (const key of empty) problems.push(`${locale}: empty ${JSON.stringify(key)}`);
      for (const key of mismatched)
        problems.push(`${locale}: placeholder drift ${JSON.stringify(key)}`);
    }
    expect(problems).toEqual([]);
  });

  it("rejects repr-garbage values and untranslated echoes", () => {
    // Only the documented glossary (brands, protocols, slugged ids) may equal
    // its key; everything else with English letters must be translated.
    const problems = [];
    for (const [locale, map] of locales) {
      for (const [key, value] of Object.entries(map)) {
        if (REPR_RE.test(value)) {
          problems.push(`${locale}: repr-garbage ${JSON.stringify(key)}`);
        } else if (value === key && /[a-zA-Z]{3,}/.test(key) && !isVerbatim(key)) {
          problems.push(`${locale}: untranslated echo ${JSON.stringify(key)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
