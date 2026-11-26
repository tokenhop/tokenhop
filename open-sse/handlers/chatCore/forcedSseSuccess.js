import { buildRequestDetail, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { saveRequestDetailUnscoped } from "../../services/usageSink.js";

/**
 * Build the success recorder of a forced-SSE → JSON aggregation, shared by
 * the Responses branch (responsesSseToJson.js) and the Chat Completions /
 * native Claude branch of handleForcedSSEToJson.
 * - `recordUsage(usage)`: request log, usage stats and the done line; returns
 *   the total latency it logged.
 * - `recordDetail(response, tokens, totalLatency?)`: the request detail;
 *   measures the latency itself when none is given.
 * - `recordSuccess(usage, response)`: both, with one shared latency.
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
  const recordUsage = (usage) => {
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
    return totalLatency;
  };

  const recordDetail = (response, tokens, totalLatency = Date.now() - requestStartTime) => {
    saveRequestDetailUnscoped(
      buildRequestDetail(
        {
          ...ctx,
          latency: { ttft: totalLatency, total: totalLatency },
          tokens,
          response,
          status: "success",
        },
        { endpoint: clientRawRequest?.endpoint || null },
      ),
    ).catch(() => {});
  };

  const recordSuccess = (usage, response) => recordDetail(response, usage, recordUsage(usage));

  return { recordUsage, recordDetail, recordSuccess };
}
