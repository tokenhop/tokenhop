import { ALL_CLIENT_KEYS, CLIENT_KEY, CLIENT_NAME, LEGACY_CLIENT_KEYS } from "@/lib/cliToolBrand";

export const GROK_MAIN_MODEL_SLOT = CLIENT_KEY;
export const GROK_BUILTIN_DEFAULT = "grok-build";
export const GROK_SUBAGENT_TYPES = ["general-purpose", "explore", "plan"];

const unsetSentinel = (key) => `__${key}_unset__`;
const UNSET_SENTINEL = unsetSentinel(CLIENT_KEY);
const MODELS_SECTION = "models";
const GATEWAY_DESCRIPTION = `Routed via ${CLIENT_NAME} gateway`;
const SUBAGENT_MODELS_SECTION = "subagents.models";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Reset and restore recognise slots and markers written under any brand key.
const ANY_KEY = `(?:${ALL_CLIENT_KEYS.map(escapeRegExp).join("|")})`;
const isUnset = (value) => ALL_CLIENT_KEYS.some((key) => value === unsetSentinel(key));
const isMainSlot = (value) => ALL_CLIENT_KEYS.includes(value);
const isSubagentSlot = (value, type) => ALL_CLIENT_KEYS.some((key) => value === `${key}-${type}`);
const tomlString = (value) => JSON.stringify(String(value));

const sectionRegExp = (section) =>
  new RegExp(`^\\[${escapeRegExp(section)}\\][ \\t]*\\r?\\n((?:(?!\\[)[^\\r\\n]*\\r?\\n?)*)`, "m");

const modelSlot = (type) => `${GROK_MAIN_MODEL_SLOT}-${type}`;

const previousDefaultRegExp = new RegExp(
  `^# ${ANY_KEY}-prev-default = "([^"]*)"[ \\t]*\\r?\\n?`,
  "m",
);
const previousSubagentRegExp = (type) =>
  new RegExp(`^# ${ANY_KEY}-prev-subagent-${escapeRegExp(type)} = "([^"]*)"[ \\t]*\\r?\\n?`, "m");

function getSectionField(toml, section, key) {
  const match = toml.match(sectionRegExp(section));
  if (!match) return null;
  const field = match[1].match(
    new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*"([^"]*)"`, "m"),
  );
  return field ? field[1] : null;
}

function getSectionNumber(toml, section, key) {
  const match = toml.match(sectionRegExp(section));
  if (!match) return null;
  const field = match[1].match(
    new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*([0-9]+(?:\\.[0-9]+)?)`, "m"),
  );
  if (!field) return null;
  const value = Number(field[1]);
  return Number.isFinite(value) ? value : null;
}

function setSectionField(toml, section, key, value) {
  const match = toml.match(sectionRegExp(section));
  const line = `${key} = ${tomlString(value)}`;
  if (!match) {
    const prefix = toml.length > 0 && !toml.endsWith("\n") ? `${toml}\n` : toml;
    return `${prefix}\n[${section}]\n${line}\n`;
  }

  const body = match[1] || "";
  const fieldRegExp = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*"[^"]*"`, "m");
  const nextBody = fieldRegExp.test(body) ? body.replace(fieldRegExp, line) : `${line}\n${body}`;
  return toml.replace(match[0], `[${section}]\n${nextBody}`);
}

function deleteSectionField(toml, section, key) {
  const match = toml.match(sectionRegExp(section));
  if (!match) return toml;
  const fieldRegExp = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=[^\\r\\n]*\\r?\\n?`, "m");
  const nextBody = (match[1] || "").replace(fieldRegExp, "");
  if (!nextBody.trim()) return toml.replace(match[0], "").replace(/\n{3,}/g, "\n\n");
  return toml.replace(match[0], `[${section}]\n${nextBody}`);
}

function parseModelSection(toml, slot) {
  const match = toml.match(sectionRegExp(`model.${slot}`));
  if (!match) return null;
  const body = match[1] || "";
  const contextWindow = getSectionNumber(toml, `model.${slot}`, "context_window");
  return {
    model: getSectionField(toml, `model.${slot}`, "model"),
    base_url: getSectionField(toml, `model.${slot}`, "base_url"),
    name: getSectionField(toml, `model.${slot}`, "name"),
    api_key: getSectionField(toml, `model.${slot}`, "api_key"),
    api_backend: getSectionField(toml, `model.${slot}`, "api_backend"),
    context_window: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
    raw: body,
  };
}

function buildModelSection({ slot, model, baseUrl, apiKey, contextWindow, name }) {
  const lines = [
    `[model.${slot}]`,
    `model = ${tomlString(model)}`,
    `base_url = ${tomlString(baseUrl)}`,
    `name = ${tomlString(name)}`,
    `description = ${tomlString(GATEWAY_DESCRIPTION)}`,
    `api_backend = "chat_completions"`,
  ];
  if (apiKey) lines.push(`api_key = ${tomlString(apiKey)}`);
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    lines.push(`context_window = ${Math.floor(contextWindow)}`);
  }
  return `${lines.join("\n")}\n`;
}

function upsertModelSection(toml, config) {
  const regexp = sectionRegExp(`model.${config.slot}`);
  const section = buildModelSection(config);
  if (regexp.test(toml)) return toml.replace(regexp, section);
  const prefix = toml.length > 0 && !toml.endsWith("\n") ? `${toml}\n` : toml;
  return `${prefix}\n${section}`;
}

function removeModelSection(toml, slot) {
  return toml.replace(sectionRegExp(`model.${slot}`), "").replace(/\n{3,}/g, "\n\n");
}

function insertMarker(toml, marker) {
  const mainSection = sectionRegExp(`model.${GROK_MAIN_MODEL_SLOT}`);
  if (mainSection.test(toml)) {
    return toml.replace(mainSection, (section) => `${marker}${section}`);
  }
  const prefix = toml.length > 0 && !toml.endsWith("\n") ? `${toml}\n` : toml;
  return `${prefix}${marker}`;
}

function rememberPreviousDefault(toml) {
  if (previousDefaultRegExp.test(toml)) return toml;
  const current = getSectionField(toml, MODELS_SECTION, "default");
  if (!current || isMainSlot(current)) return toml;
  return insertMarker(toml, `# ${CLIENT_KEY}-prev-default = ${tomlString(current)}\n`);
}

function restorePreviousDefault(toml) {
  const previous = toml.match(previousDefaultRegExp)?.[1] || GROK_BUILTIN_DEFAULT;
  let next = toml.replace(previousDefaultRegExp, "");
  if (isMainSlot(getSectionField(next, MODELS_SECTION, "default"))) {
    next = setSectionField(next, MODELS_SECTION, "default", previous);
  }
  return next;
}

function rememberPreviousSubagent(toml, type) {
  const regexp = previousSubagentRegExp(type);
  if (regexp.test(toml)) return toml;
  const current = getSectionField(toml, SUBAGENT_MODELS_SECTION, type);
  const previous = current == null || isSubagentSlot(current, type) ? UNSET_SENTINEL : current;
  return insertMarker(toml, `# ${CLIENT_KEY}-prev-subagent-${type} = ${tomlString(previous)}\n`);
}

function restorePreviousSubagent(toml, type) {
  const regexp = previousSubagentRegExp(type);
  const previous = toml.match(regexp)?.[1] || UNSET_SENTINEL;
  const next = toml.replace(regexp, "");
  if (!isSubagentSlot(getSectionField(next, SUBAGENT_MODELS_SECTION, type), type)) {
    return next;
  }
  if (isUnset(previous)) {
    return deleteSectionField(next, SUBAGENT_MODELS_SECTION, type);
  }
  return setSectionField(next, SUBAGENT_MODELS_SECTION, type, previous);
}

// legacy(9router): remove in v2 — rename slots, markers and references a legacy
// brand key wrote to ours, so Apply keeps the user's models and previous values.
function migrateLegacySlots(toml) {
  let next = toml;
  for (const legacy of LEGACY_CLIENT_KEYS) {
    next = next
      .replace(
        new RegExp(`^# ${escapeRegExp(legacy)}-prev-([a-z-]+) = [^\\r\\n]*\\r?\\n?`, "gm"),
        (line, suffix) => (next.includes(`# ${CLIENT_KEY}-prev-${suffix} =`) ? "" : line),
      )
      .replace(new RegExp(`^# ${escapeRegExp(legacy)}-prev-`, "gm"), `# ${CLIENT_KEY}-prev-`)
      .replaceAll(tomlString(unsetSentinel(legacy)), tomlString(UNSET_SENTINEL));
    const slots = [[legacy, CLIENT_KEY, CLIENT_NAME]].concat(
      GROK_SUBAGENT_TYPES.map((type) => [
        `${legacy}-${type}`,
        modelSlot(type),
        `${CLIENT_NAME} ${type}`,
      ]),
    );
    for (const [from, to, name] of slots) {
      if (!sectionRegExp(`model.${from}`).test(next)) continue;
      if (sectionRegExp(`model.${to}`).test(next)) {
        next = removeModelSection(next, from);
        continue;
      }
      next = next.replace(
        sectionRegExp(`model.${from}`),
        (_, body) =>
          `[model.${to}]\n${body
            .replace(/^name[ \t]*=.*$/m, `name = ${tomlString(name)}`)
            .replace(
              /^description[ \t]*=.*$/m,
              `description = ${tomlString(GATEWAY_DESCRIPTION)}`,
            )}`,
      );
    }
    if (getSectionField(next, MODELS_SECTION, "default") === legacy) {
      next = setSectionField(next, MODELS_SECTION, "default", CLIENT_KEY);
    }
    for (const type of GROK_SUBAGENT_TYPES) {
      if (getSectionField(next, SUBAGENT_MODELS_SECTION, type) === `${legacy}-${type}`) {
        next = setSectionField(next, SUBAGENT_MODELS_SECTION, type, modelSlot(type));
      }
    }
  }
  return next;
}

const findMainSlot = (toml) =>
  ALL_CLIENT_KEYS.find((key) => sectionRegExp(`model.${key}`).test(toml)) ?? CLIENT_KEY;

export function parseGrokBuildConfig(toml) {
  const subagentModels = {};
  const subagentMappings = {};
  for (const type of GROK_SUBAGENT_TYPES) {
    const mapping = getSectionField(toml, SUBAGENT_MODELS_SECTION, type);
    subagentMappings[type] = mapping;
    subagentModels[type] = isSubagentSlot(mapping, type) ? parseModelSection(toml, mapping) : null;
  }

  return {
    model: parseModelSection(toml, findMainSlot(toml)),
    default: getSectionField(toml, MODELS_SECTION, "default"),
    subagentModels,
    subagentMappings,
  };
}

/**
 * Apply main model and optional per-type subagent overrides while preserving all unrelated TOML.
 * `subagentModels === undefined` leaves existing subagent config untouched for API compatibility.
 */
export function applyGrokBuildConfig(
  toml,
  { baseUrl, apiKey, model, contextWindow, subagentModels },
) {
  let next = rememberPreviousDefault(migrateLegacySlots(toml));
  next = upsertModelSection(next, {
    slot: GROK_MAIN_MODEL_SLOT,
    model,
    baseUrl,
    apiKey,
    contextWindow,
    name: CLIENT_NAME,
  });
  next = setSectionField(next, MODELS_SECTION, "default", GROK_MAIN_MODEL_SLOT);

  if (subagentModels && typeof subagentModels === "object") {
    for (const type of GROK_SUBAGENT_TYPES) {
      const selected = subagentModels[type];
      const slot = modelSlot(type);
      if (selected?.model) {
        next = rememberPreviousSubagent(next, type);
        next = upsertModelSection(next, {
          slot,
          model: selected.model,
          baseUrl,
          apiKey,
          contextWindow: selected.contextWindow,
          name: `${CLIENT_NAME} ${type}`,
        });
        next = setSectionField(next, SUBAGENT_MODELS_SECTION, type, slot);
      } else {
        next = restorePreviousSubagent(next, type);
        next = removeModelSection(next, slot);
      }
    }
  }

  return next;
}

export function resetGrokBuildConfig(toml) {
  let next = toml;
  for (const type of GROK_SUBAGENT_TYPES) {
    next = restorePreviousSubagent(next, type);
    for (const key of ALL_CLIENT_KEYS) next = removeModelSection(next, `${key}-${type}`);
  }
  for (const key of ALL_CLIENT_KEYS) next = removeModelSection(next, key);
  next = restorePreviousDefault(next);
  return next.replace(/\n{3,}/g, "\n\n");
}

export function getGrokSubagentSlot(type) {
  return GROK_SUBAGENT_TYPES.includes(type) ? modelSlot(type) : null;
}
