/**
 * Shared Signal Monaco theme definitions for secondary/debug pages.
 * Reads live Signal token values from CSS so Monaco stays in sync with
 * the active theme. Falls back to the canonical token values when a
 * variable is unavailable (e.g. Node unit tests).
 */

/**
 * @param {string} name CSS variable name, e.g. "--signal-panel".
 * @param {string} fallback Hex color used when the variable cannot be read.
 * @returns {string} Resolved color value.
 */
export function signalToken(name, fallback) {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}
export const SIGNAL_MONACO_DARK = "signal-dark";
export const SIGNAL_MONACO_LIGHT = "signal-light";

/**
 * Register the two Signal Monaco themes once per Monaco instance.
 *
 * @param {object} monaco Monaco instance from `@monaco-editor/react` `beforeMount`.
 */
export function defineSignalMonacoThemes(monaco) {
  monaco.editor.defineTheme(SIGNAL_MONACO_DARK, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": signalToken("--signal-panel", "#15171D"),
      "editor.foreground": signalToken("--signal-text", "#F3F2EE"),
      "editor.lineHighlightBackground": signalToken("--signal-raised", "#1C1F27"),
      "editorLineNumber.foreground": signalToken("--signal-subtle", "#838898"),
      "editorLineNumber.activeForeground": signalToken("--signal-text", "#F3F2EE"),
      "editorCursor.foreground": signalToken("--signal-coral", "#FF6A48"),
      "editor.selectionBackground": `${signalToken("--signal-coral", "#FF6A48")}33`,
      "editor.inactiveSelectionBackground": `${signalToken("--signal-coral", "#FF6A48")}22`,
      "editorWidget.background": signalToken("--signal-panel", "#15171D"),
      "editorWidget.border": signalToken("--signal-line", "#2A2E39"),
      "editorHoverWidget.background": signalToken("--signal-raised", "#1C1F27"),
      "editorHoverWidget.border": signalToken("--signal-line", "#2A2E39"),
      "editorSuggestWidget.background": signalToken("--signal-panel", "#15171D"),
      "editorSuggestWidget.border": signalToken("--signal-line", "#2A2E39"),
      "editorGutter.background": signalToken("--signal-panel", "#15171D"),
      "editor.lineHighlightBorder": "#00000000",
    },
  });
  monaco.editor.defineTheme(SIGNAL_MONACO_LIGHT, {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": signalToken("--signal-panel", "#FFFFFF"),
      "editor.foreground": signalToken("--signal-text", "#16171C"),
      "editor.lineHighlightBackground": signalToken("--signal-raised", "#F7F5EF"),
      "editorLineNumber.foreground": signalToken("--signal-subtle", "#6C7080"),
      "editorLineNumber.activeForeground": signalToken("--signal-text", "#16171C"),
      "editorCursor.foreground": signalToken("--signal-coral", "#CF4323"),
      "editor.selectionBackground": `${signalToken("--signal-coral", "#CF4323")}33`,
      "editor.inactiveSelectionBackground": `${signalToken("--signal-coral", "#CF4323")}22`,
      "editorWidget.background": signalToken("--signal-panel", "#FFFFFF"),
      "editorWidget.border": signalToken("--signal-line", "#E2DED3"),
      "editorHoverWidget.background": signalToken("--signal-raised", "#F7F5EF"),
      "editorHoverWidget.border": signalToken("--signal-line", "#E2DED3"),
      "editorSuggestWidget.background": signalToken("--signal-panel", "#FFFFFF"),
      "editorSuggestWidget.border": signalToken("--signal-line", "#E2DED3"),
      "editorGutter.background": signalToken("--signal-panel", "#FFFFFF"),
      "editor.lineHighlightBorder": "#00000000",
    },
  });
}

/**
 * Pretty-print JSON for the translator debug editors.
 *
 * @param {string} value Raw editor content.
 * @returns {string|null} Formatted JSON, or null when it cannot be parsed.
 */
export function safeFormatJson(value) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return null;
  }
}
