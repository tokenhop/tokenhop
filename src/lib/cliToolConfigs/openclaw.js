// Open Claw: openclaw.json plus one models.json per agent that has an agentDir.
import { CLIENT_KEY, modelRef } from "@/lib/cliToolBrand";
import { withV1 } from "./shared";

const modelEntry = (id) => ({ id, name: id.split("/").pop() || id });

/**
 * `agents` is `[{ id, agentDir }]`; `agentModels` maps agent id → model override.
 * `null` without a model.
 */
export function buildOpenClawConfig({ baseUrl, apiKey, model, agents = [], agentModels = {} }) {
  if (!model) return null;

  const provider = (models) => ({
    baseUrl: withV1(baseUrl),
    apiKey,
    api: "openai-completions",
    models: models.map(modelEntry),
  });
  const allModels = [...new Set([model, ...Object.values(agentModels).filter(Boolean)])];
  const list = agents
    .filter((agent) => agentModels[agent.id])
    .map((agent) => ({ id: agent.id, model: modelRef(agentModels[agent.id]) }));

  return [
    {
      file: "~/.openclaw/openclaw.json",
      format: "json",
      merge: true,
      note: "Merge these keys into the existing file. Match agents.list entries by id.",
      value: {
        agents: {
          defaults: {
            model: { primary: modelRef(model) },
            models: Object.fromEntries(allModels.map((m) => [modelRef(m), {}])),
          },
          ...(list.length && { list }),
        },
        models: { providers: { [CLIENT_KEY]: provider(allModels) } },
      },
    },
    ...agents
      .filter((agent) => agent.agentDir)
      .map((agent) => ({
        file: `${agent.agentDir}/models.json`,
        format: "json",
        merge: true,
        value: { providers: { [CLIENT_KEY]: provider([agentModels[agent.id] || model]) } },
      })),
  ];
}
