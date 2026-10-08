import { describe, it, expect } from "vitest";
import {
  deriveSecurityState,
  isLoginUnsafe,
  canExposeRemote,
  buildQuickConnectSnippet,
  quickConnectSnippets,
  buildZedEditPredictionConfig,
  buildNeovimMinuetConfig,
  duplicateKeyLabel,
  maskKey,
  formatLastUsed,
  isNewKey,
  formatNumber,
} from "@/app/(dashboard)/dashboard/endpoint/endpointLogic";

describe("deriveSecurityState", () => {
  const base = {
    requireApiKey: true,
    requireLogin: true,
    hasPassword: true,
    tunnelEnabled: false,
    tsEnabled: false,
    tunnelDashboardAccess: false,
  };

  it("is ok when everything is locked down", () => {
    const state = deriveSecurityState(base);
    expect(state.variant).toBe("ok");
    expect(state.message).toContain("Locked down");
  });

  it("is ok when tunnel is on but key and login are on", () => {
    const state = deriveSecurityState({
      ...base,
      tunnelEnabled: true,
      tunnelDashboardAccess: true,
    });
    expect(state.variant).toBe("ok");
  });

  it("is ok locally with no key and login off when nothing is exposed", () => {
    const state = deriveSecurityState({ ...base, requireApiKey: false, requireLogin: false });
    expect(state.variant).toBe("ok");
    expect(state.message).toContain("Local only");
  });

  it("warns about the default password even when nothing is exposed", () => {
    const state = deriveSecurityState({ ...base, hasPassword: false });
    expect(state.variant).toBe("warn");
    expect(state.message.toLowerCase()).toContain("default password");
    expect(state.fix.href).toBe("/dashboard/profile");
  });

  it("treats a remote dashboard host as exposed for the API key check", () => {
    const state = deriveSecurityState({ ...base, requireApiKey: false, remoteHost: true });
    expect(state.variant).toBe("warn");
    expect(state.message).toContain("API key");
  });

  it("describes the tunnel-on, dashboard-off, login-off state honestly", () => {
    const state = deriveSecurityState({
      ...base,
      tunnelEnabled: true,
      requireLogin: false,
      tunnelDashboardAccess: false,
    });
    expect(state.variant).toBe("ok");
    expect(state.message).not.toContain("login on");
  });

  it("is ok when dashboard-over-tunnel is off even with login off", () => {
    const state = deriveSecurityState({
      ...base,
      tunnelEnabled: true,
      tunnelDashboardAccess: false,
      requireLogin: false,
    });
    expect(state.variant).toBe("ok");
  });

  it("warns when exposed without an API key (Cloudflare tunnel)", () => {
    const state = deriveSecurityState({
      ...base,
      requireApiKey: false,
      tunnelEnabled: true,
    });
    expect(state.variant).toBe("warn");
    expect(state.message).toContain("API key");
    expect(state.fix).toEqual({ label: "Enable", href: "#require-api-key" });
  });

  it("warns when exposed without an API key (Tailscale)", () => {
    const state = deriveSecurityState({ ...base, requireApiKey: false, tsEnabled: true });
    expect(state.variant).toBe("warn");
    expect(state.message).toContain("API key");
  });

  it("warns when dashboard-over-tunnel is on and login is off", () => {
    const state = deriveSecurityState({
      ...base,
      tunnelEnabled: true,
      tunnelDashboardAccess: true,
      requireLogin: false,
    });
    expect(state.variant).toBe("warn");
    expect(state.message).toContain("Require login");
    expect(state.fix).toBeTruthy();
  });

  it("warns when dashboard-over-tunnel is on and the password is default", () => {
    const state = deriveSecurityState({
      ...base,
      tunnelEnabled: true,
      tunnelDashboardAccess: true,
      hasPassword: false,
    });
    expect(state.variant).toBe("warn");
    expect(state.message.toLowerCase()).toContain("password");
  });

  it("reports the API key risk first when both are open", () => {
    const state = deriveSecurityState({
      ...base,
      requireApiKey: false,
      requireLogin: false,
      tunnelEnabled: true,
      tunnelDashboardAccess: true,
    });
    expect(state.variant).toBe("warn");
    expect(state.message).toContain("API key");
  });

  it("treats requireLogin default (undefined) as on", () => {
    const state = deriveSecurityState({
      ...base,
      requireLogin: undefined,
      tunnelEnabled: true,
      tunnelDashboardAccess: true,
    });
    expect(state.variant).toBe("ok");
  });
});

describe("isLoginUnsafe / canExposeRemote", () => {
  it("flags login unsafe when off or default password", () => {
    expect(isLoginUnsafe({ requireLogin: false, hasPassword: true })).toBe(true);
    expect(isLoginUnsafe({ requireLogin: true, hasPassword: false })).toBe(true);
    expect(isLoginUnsafe({ requireLogin: true, hasPassword: true })).toBe(false);
  });

  it("requires safe login and requireApiKey before remote exposure", () => {
    expect(canExposeRemote({ requireLogin: true, hasPassword: true, requireApiKey: true })).toBe(
      true,
    );
    expect(canExposeRemote({ requireLogin: true, hasPassword: true, requireApiKey: false })).toBe(
      false,
    );
    expect(canExposeRemote({ requireLogin: false, hasPassword: true, requireApiKey: true })).toBe(
      false,
    );
  });
});

describe("buildQuickConnectSnippet", () => {
  const base = "http://localhost:20142/v1";

  it("builds the shell snippet", () => {
    expect(buildQuickConnectSnippet("shell", base, "sk-9r-abcdef1234")).toBe(
      `export OPENAI_BASE_URL=${base}\nexport OPENAI_API_KEY=sk-9r-abcdef1234`,
    );
  });

  it("builds the curl snippet", () => {
    expect(buildQuickConnectSnippet("curl", base, "KEY")).toContain(
      `curl ${base}/chat/completions`,
    );
    expect(buildQuickConnectSnippet("curl", base, "KEY")).toContain(`'Authorization: Bearer KEY'`);
  });

  it("builds the python snippet", () => {
    const s = buildQuickConnectSnippet("python", base, "KEY");
    expect(s).toContain(`base_url="${base}"`);
    expect(s).toContain(`api_key="KEY"`);
  });

  it("shell-escapes single quotes in values", () => {
    expect(buildQuickConnectSnippet("shell", base, "a'b")).toBe(
      `export OPENAI_BASE_URL=${base}\nexport OPENAI_API_KEY='a'\\''b'`,
    );
  });

  it("curl single-quotes the auth header so shell quoting survives", () => {
    const s = buildQuickConnectSnippet("curl", base, "a'b");
    expect(s).toContain(`-H 'Authorization: Bearer 'a'\\''b''`);
  });

  it("python escapes backslashes and double quotes", () => {
    const s = buildQuickConnectSnippet("python", 'http://x\\"y/v1', 'k"e\\y');
    expect(s).toContain('base_url="http://x\\\\\\"y/v1"');
    expect(s).toContain('api_key="k\\"e\\\\y"');
  });

  it("throws on unknown kind", () => {
    expect(() => buildQuickConnectSnippet("ruby", base, "k")).toThrow();
  });
});

describe("quickConnectSnippets", () => {
  const keys = [
    { id: "one", name: "Default Key", key: "sk-9r-abcdef1234" },
    { id: "two", name: "Default Key", key: "sk-9r-ghijkl5678" },
  ];

  it.each(["shell", "curl", "python"])(
    "masks display but copies the selected real key in %s",
    (kind) => {
      for (const selected of keys) {
        const { display, copy } = quickConnectSnippets(kind, "http://localhost:20166/v1", selected);
        expect(display).toContain(maskKey(selected.key));
        expect(display).not.toContain(selected.key);
        expect(copy).toContain(selected.key);
        expect(copy).not.toContain("••••");
        expect(copy).toBe(
          buildQuickConnectSnippet(kind, "http://localhost:20166/v1", selected.key),
        );
      }
    },
  );

  it("never substitutes a placeholder for an absent selection", () => {
    expect(quickConnectSnippets("shell", "/v1", null).copy).toBeNull();
  });

  it("suffixes duplicate names without exposing the key", () => {
    expect(duplicateKeyLabel(keys[0], keys)).toBe("Default Key …1234");
    expect(duplicateKeyLabel(keys[1], keys)).toBe("Default Key …5678");
    expect(duplicateKeyLabel({ ...keys[0], name: "Other" }, keys)).toBe("Other");
  });
});

describe("maskKey", () => {
  it("masks the middle and keeps prefix/suffix", () => {
    expect(maskKey("sk-9r-abcdef1234")).toBe("sk-9r-••••1234");
  });

  it("returns short keys unchanged", () => {
    expect(maskKey("short")).toBe("short");
    expect(maskKey("12345678")).toBe("12345678");
  });

  it("handles null/empty", () => {
    expect(maskKey(null)).toBe("");
    expect(maskKey("")).toBe("");
  });
});

describe("formatLastUsed", () => {
  it("returns Never for null", () => {
    expect(formatLastUsed(null)).toBe("Never");
  });

  it("shows relative time", () => {
    const now = Date.now();
    expect(formatLastUsed(new Date(now - 30_000).toISOString())).toBe("Just now");
    expect(formatLastUsed(new Date(now - 90_000).toISOString())).toBe("1 min ago");
    expect(formatLastUsed(new Date(now - 3 * 3600_000).toISOString())).toBe("3h ago");
    expect(formatLastUsed(new Date(now - 2 * 86400_000).toISOString())).toBe("2 days ago");
  });

  it("returns invalid input as Never", () => {
    expect(formatLastUsed("not-a-date")).toBe("Never");
  });
});

describe("isNewKey", () => {
  it("flags keys younger than 48h", () => {
    expect(isNewKey(new Date().toISOString())).toBe(true);
    expect(isNewKey(new Date(Date.now() - 25 * 3600_000).toISOString())).toBe(true);
    expect(isNewKey(new Date(Date.now() - 49 * 3600_000).toISOString())).toBe(false);
    expect(isNewKey(null)).toBe(false);
    expect(isNewKey("garbage")).toBe(false);
  });
});

describe("formatNumber", () => {
  it("formats with locale separators", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(1204)).toBe("1,204");
    expect(formatNumber(null)).toBe("0");
    expect(formatNumber(undefined)).toBe("0");
  });
});

describe("edit prediction snippets", () => {
  const base = "http://localhost:20128/v1";

  it("zed config parses with required fields and trims trailing slashes", () => {
    const parsed = JSON.parse(buildZedEditPredictionConfig(`${base}///`, "prediction-fast"));
    expect(parsed.edit_predictions.provider).toBe("open_ai_compatible_api");
    const api = parsed.edit_predictions.open_ai_compatible_api;
    expect(api.api_url).toBe(`${base}/completions`);
    expect(api.model).toBe("prediction-fast");
    expect(api.prompt_format).toBe("qwen");
    expect(api.max_output_tokens).toBe(128);
    expect(api.prediction_debounce).toBe(150);
  });

  it("zed config round-trips quote/backslash/newline/non-ASCII model ids", () => {
    const model = 'combo "x"\\y\nzé日本語';
    const api = JSON.parse(buildZedEditPredictionConfig(base, model)).edit_predictions
      .open_ai_compatible_api;
    expect(api.model).toBe(model);
  });

  it("zed config defaults the base URL", () => {
    const api = JSON.parse(buildZedEditPredictionConfig(undefined, "m")).edit_predictions
      .open_ai_compatible_api;
    expect(api.api_url).toBe("http://localhost:20128/v1/completions");
  });

  it("neovim config uses decimal C0 escapes and no JSON unicode escapes", () => {
    expect(buildNeovimMinuetConfig(base, "a\x012")).toContain('model = "a\\0012"');
    expect(buildNeovimMinuetConfig(base, "a\nb\tc")).toContain('model = "a\\nb\\tc"');
    expect(buildNeovimMinuetConfig(base, "\x1b\x7f")).toContain('model = "\\027\\127"');
    expect(buildNeovimMinuetConfig(base, "日本語")).toContain('model = "日本語"');
    expect(buildNeovimMinuetConfig(base, "a\x012")).not.toContain("\\u");
  });

  it("neovim config pins qwen template, suffix=false and env-name api key", () => {
    const cfg = buildNeovimMinuetConfig(base, "prediction-fast");
    expect(cfg).toContain('end_point = "http://localhost:20128/v1/completions"');
    expect(cfg).toContain('model = "prediction-fast"');
    expect(cfg).toContain('api_key = "TOKENHOP_API_KEY"');
    expect(cfg).toContain("max_tokens = 128");
    expect(cfg).toContain("<|fim_prefix|>");
    expect(cfg).toContain("<|fim_suffix|>");
    expect(cfg).toContain("<|fim_middle|>");
    expect(cfg).toContain("suffix = false");
  });

  it.each(["zed", "neovim"])(
    "masks display, copies real export, keeps config secret-free in %s",
    (kind) => {
      const env =
        kind === "zed" ? "ZED_OPEN_AI_COMPATIBLE_EDIT_PREDICTION_API_KEY" : "TOKENHOP_API_KEY";
      const real = "sk-9r-abcdef1234";
      const { display, copy, config } = quickConnectSnippets(
        kind,
        base,
        { key: real },
        "prediction-fast",
      );
      expect(display).toContain(maskKey(real));
      expect(display).not.toContain(real);
      expect(copy).toBe(`export ${env}=${real}`);
      expect(config).toContain("prediction-fast");
      expect(config).not.toContain(real);
    },
  );

  it("masks short real keys in display but copies them", () => {
    const { display, copy } = quickConnectSnippets("zed", base, { key: "abc" }, "m");
    expect(display).toContain("••••••••");
    expect(display).not.toContain("abc");
    expect(copy).toContain("abc");
  });

  it("shell-quotes special keys in editor export copy", () => {
    expect(quickConnectSnippets("neovim", base, { key: "a'b" }, "m").copy).toBe(
      "export TOKENHOP_API_KEY='a'\\''b'",
    );
  });

  it("returns null copy for prefix-only keys even with config, null config for blank model", () => {
    const hashed = quickConnectSnippets("neovim", base, { prefix: "th_abcd" }, "prediction-fast");
    expect(hashed.copy).toBeNull();
    expect(hashed.config).toContain("prediction-fast");
    const sel = { key: "sk-9r-abcdef1234" };
    expect(quickConnectSnippets("zed", base, sel, "").config).toBeNull();
    expect(quickConnectSnippets("zed", base, sel, "   ").config).toBeNull();
  });
});
