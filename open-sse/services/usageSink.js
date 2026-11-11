// Injected usage/request-log sink. open-sse never imports src/; the app installs
// the real writers at startup (src/instrumentation.js -> src/sse/services/usageSink.js).
// The slot lives on globalThis so duplicate bundle copies of this module agree
// (same pattern as credentialStore). With no sink installed (standalone open-sse)
// every call is a no-op, so usage tracking never blocks or breaks a request.
const SLOT = Symbol.for("tokenhop.usageSink");

/** Install (or clear with null) the sink: { trackPendingRequest, appendRequestLog, saveRequestDetailUnscoped, saveRequestUsageUnscoped }. */
export function setUsageSink(sink) {
  globalThis[SLOT] = sink || null;
}

export function trackPendingRequest(...args) {
  return globalThis[SLOT]?.trackPendingRequest?.(...args);
}

export async function appendRequestLog(...args) {
  return globalThis[SLOT]?.appendRequestLog?.(...args);
}

export async function saveRequestDetailUnscoped(...args) {
  return globalThis[SLOT]?.saveRequestDetailUnscoped?.(...args);
}

export async function saveRequestUsageUnscoped(...args) {
  return globalThis[SLOT]?.saveRequestUsageUnscoped?.(...args);
}
