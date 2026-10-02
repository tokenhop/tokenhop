import { describe, expect, it } from "vitest";
import {
  API_KEY_PLACEHOLDER,
  displayPath,
  formatLabel,
  manualMissingInputs,
  toManualConfigs,
} from "@/lib/cliToolConfigs/shared";

describe("manual setup dialog helpers (YAN-621)", () => {
  it("labels the format, using the extension for text fragments", () => {
    expect(formatLabel({ file: "a.json", format: "json" })).toBe("JSON");
    expect(formatLabel({ file: "~/.codex/config.toml", format: "toml" })).toBe("TOML");
    expect(formatLabel({ file: "~/.grok/config.toml", format: "text" })).toBe("TOML");
    expect(formatLabel({ file: "~/.hermes/config.yaml", format: "text" })).toBe("YAML");
    expect(formatLabel({ file: "~/.hermes/.env", format: "text" })).toBe(".env");
    expect(formatLabel({ file: "~/.config/jcode/provider-x.env", format: "text" })).toBe(".env");
  });

  it("maps ~ to %USERPROFILE% on Windows only", () => {
    expect(displayPath("~/.claude/settings.json", "win32")).toBe(
      "%USERPROFILE%\\.claude\\settings.json",
    );
    expect(displayPath("%APPDATA%\\Code\\x.json", "win32")).toBe("%APPDATA%\\Code\\x.json");
    expect(displayPath("~/.claude/settings.json", "darwin")).toBe("~/.claude/settings.json");
  });

  it("keeps file, format, merge mode and note", () => {
    const [config] = toManualConfigs([
      { file: "~/a.json", format: "json", merge: true, note: "N", value: { a: 1 } },
    ]);
    expect(config).toEqual({
      file: "~/a.json",
      format: "JSON",
      merge: true,
      note: "N",
      content: '{\n  "a": 1\n}',
    });
  });

  it("lists missing inputs instead of placeholder configs", () => {
    expect(manualMissingInputs(toManualConfigs(null))).toEqual(["model"]);
    expect(manualMissingInputs([{ content: `key=${API_KEY_PLACEHOLDER}` }])).toEqual(["apiKey"]);
    expect(manualMissingInputs([{ content: "key=sk-1" }])).toEqual([]);
  });
});
