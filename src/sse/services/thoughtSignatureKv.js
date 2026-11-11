// App-side persistence for open-sse/services/thoughtSignatureStore.js.
// Installed once at startup from src/instrumentation.js, never as an import side effect.
import { makeKv } from "@/lib/db/helpers/kvStore.js";
import { setThoughtSignatureKv } from "open-sse/services/thoughtSignatureStore.js";

const SCOPE = "gemini_thought_signatures";

export function installThoughtSignatureKv() {
  setThoughtSignatureKv(makeKv(SCOPE));
}
