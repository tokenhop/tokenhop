// App-side usage/request-log writers for open-sse/services/usageSink.js.
// Installed once at startup from src/instrumentation.js, never as an import side
// effect, so tests that mock "@/lib/usageDb.js" do not get a real sink.
import {
  appendRequestLog,
  saveRequestDetailUnscoped,
  saveRequestUsageUnscoped,
  trackPendingRequest,
} from "@/lib/usageDb.js";
import { setUsageSink } from "open-sse/services/usageSink.js";

export function installUsageSink() {
  setUsageSink({
    trackPendingRequest: (...args) => trackPendingRequest(...args),
    appendRequestLog: (...args) => appendRequestLog(...args),
    saveRequestDetailUnscoped: (...args) => saveRequestDetailUnscoped(...args),
    saveRequestUsageUnscoped: (...args) => saveRequestUsageUnscoped(...args),
  });
}
