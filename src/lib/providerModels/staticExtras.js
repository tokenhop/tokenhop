import { getModelsByProviderId } from "open-sse/config/providerModels.js";

const kindOf = (model) => model?.kind || model?.type || "llm";

// Keep static non-chat entries the live list lacks (as that kind), so a chat-only
// or partial live catalog doesn't drop embeddings/STT/etc. from /v1/models/{kind}.
export function withStaticNonChatModels(providerId, liveModels) {
  const live = new Set(liveModels.map((m) => `${kindOf(m)}:${m.id}`));
  const extras = getModelsByProviderId(providerId)
    .filter((m) => kindOf(m) !== "llm" && !live.has(`${kindOf(m)}:${m.id}`))
    .map(({ id, name, kind, type }) => ({ id, name, kind: kind || type }));
  return [...liveModels, ...extras];
}
