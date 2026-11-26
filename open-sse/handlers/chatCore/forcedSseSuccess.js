import { buildRequestDetail, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { saveRequestDetailUnscoped } from "../../services/usageSink.js";

/**
 * Build the success recorder of a forced-SSE → JSON aggregation: request log,
 * usage stats, the done line and the request detail. Shared by the Responses
 * branch (responsesSseToJson.js) and the Chat Completions / native Claude
 * branch of handleForcedSSEToJson.
 * @returns {(usage: object, response: object, detailTokens?: object) => void}
 *   `detailTokens` overrides the token counts stored in the request detail
 *   (defaults to `usage`).
 */
export function createSuccessRecorder({
  ctx,
  provider,
  model,
  connectionId,
  apiKey,
  keyContext,
  usageEndpoint,
  requestStartTime,
  clientRawRequest,
  savings,
  comboName,
  appendLog,
  reqTag,
  log,
}) {
  return (usage, response, detailTokens = usage) => {
    appendLog({ tokens: usage, status: "200 OK" });
    saveUsageStats({
      provider,
      model,
      tokens: usage,
      connectionId,
      apiKey,
      keyContext,
      endpoint: usageEndpoint,
      latencyMs: Date.now() - requestStartTime,
      userAgent: clientRawRequest?.headers?.["user-agent"],
      savings,
      comboName,
      silent: true,
    });
    const totalLatency = Date.now() - requestStartTime;
    if (log?.line)
      log.line(reqTag, "📊", formatDoneLine({ usage, latency: { total: totalLatency } }));
    saveRequestDetailUnscoped(
      buildRequestDetail(
        {
          ...ctx,
          latency: { ttft: totalLatency, total: totalLatency },
          tokens: detailTokens,
          response,
          status: "success",
        },
        { endpoint: clientRawRequest?.endpoint || null },
      ),
    ).catch(() => {});
  };
}
