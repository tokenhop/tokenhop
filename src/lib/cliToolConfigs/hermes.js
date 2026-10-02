// Pure string ops + builder for the Hermes Agent config Apply writes and the
// manual snippet shows: a top-level `model:` block in config.yaml plus an
// `OPENAI_API_KEY` line in .env. Everything else in both files is preserved.
import { withV1 } from "./shared";

export const API_KEY_ENV = "OPENAI_API_KEY";

// Match top-level "model:" block (until next non-indented, non-empty line)
export const MODEL_BLOCK_RE = /^model:[ \t]*\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)/m;

const buildModelBlock = (model, baseUrl) =>
  `model:\n  default: "${model}"\n  provider: "custom"\n  base_url: "${baseUrl}"\n  api_key: \${OPENAI_API_KEY}\n`;

export const upsertModelBlock = (yaml, newBlock) => {
  if (MODEL_BLOCK_RE.test(yaml)) return yaml.replace(MODEL_BLOCK_RE, newBlock);
  return yaml.length > 0 ? `${newBlock}\n${yaml}` : newBlock;
};

// .env helpers — upsert/remove single KEY=VALUE line
export const upsertEnvVar = (envText, key, value) => {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(envText)) return envText.replace(re, line);
  return envText.length > 0 && !envText.endsWith("\n")
    ? `${envText}\n${line}\n`
    : `${envText}${line}\n`;
};

export const buildHermesConfig = ({
  baseUrl,
  apiKey,
  model,
  existingYaml = "",
  existingEnv = "",
}) => {
  if (!model) return null;
  const fragments = [
    {
      file: "~/.hermes/config.yaml",
      format: "text",
      merge: true,
      note: "Replace the model block in the existing file, or add it at the top.",
      value: upsertModelBlock(existingYaml, buildModelBlock(model, withV1(baseUrl))),
    },
  ];
  // .env is only touched when the caller provides a key.
  if (apiKey) {
    fragments.push({
      file: "~/.hermes/.env",
      format: "text",
      merge: true,
      note: "Add this line to the existing file, replacing any line with the same name.",
      value: upsertEnvVar(existingEnv, API_KEY_ENV, apiKey),
    });
  }
  return fragments;
};
