// Factory Droid: our entries in ~/.factory/settings.json `customModels`.
import { CUSTOM_MODEL_ID_PREFIX } from "@/lib/cliToolBrand";
import { withV1 } from "@/lib/cliToolConfigs/shared";

/**
 * `customModels` for a clean settings file: ids `<prefix><position in models>`,
 * the active model moved first, then indexed by position. An empty `activeModel`
 * means no default (list order kept). `null` without a usable model.
 */
export const buildDroidConfig = ({ baseUrl, apiKey, models, activeModel }) => {
  const list = Array.isArray(models) ? models : [];
  const customModels = [];
  list.forEach((model, i) => {
    if (!model || typeof model !== "string") return;
    customModels.push({
      model,
      id: `${CUSTOM_MODEL_ID_PREFIX}${i}`,
      index: i,
      baseUrl: withV1(baseUrl),
      apiKey,
      displayName: model,
      maxOutputTokens: 131072,
      noImageSupport: false,
      provider: "openai",
    });
  });
  if (customModels.length === 0) return null;

  let defaultIndex = 0;
  if (typeof activeModel === "string") {
    if (activeModel === "") defaultIndex = -1;
    else defaultIndex = Math.max(list.indexOf(activeModel), 0);
  }
  if (customModels[defaultIndex]) {
    const [defaultEntry] = customModels.splice(defaultIndex, 1);
    customModels.unshift(defaultEntry);
    customModels.forEach((entry, i) => {
      entry.index = i;
    });
  }

  return [
    {
      file: "~/.factory/settings.json",
      format: "json",
      merge: true,
      value: { customModels },
    },
  ];
};
