import { createRoot } from "react-dom/client";
import {
  ApiKeysFixture,
  BulkFixture,
  ComboFixture,
  ConnectionFixture,
  ListFixture,
  NodeFixture,
} from "./list-fixture.jsx";
import { ModelsFixture } from "./model-fixture.jsx";

const mode = new URLSearchParams(location.search).get("mode") || "delayed";
window.fixture = {
  requests: [],
  refreshed: false,
  focusLog: [],
  commits: [],
  syncDelta: null,
  releaseRefresh: null,
  refreshPending: false,
};

document.addEventListener("focusin", ({ target }) => {
  window.fixture.focusLog.push(
    target.getAttribute?.("aria-label") ||
      target.textContent?.trim().slice(0, 60) ||
      target.tagName,
  );
});

/** Fake transport: records move requests; unexpected URLs throw so a fixture bug is loud. */
window.fetch = async (url, init) => {
  const href = String(url);
  if (href === "/api/models") return new Response(JSON.stringify({ models: [] }), { status: 200 });
  if (href.startsWith("/api/providers")) {
    return new Response(
      JSON.stringify({
        connections: [
          { id: "bulk-1", name: "Bulk One", provider: "openai" },
          { id: "bulk-2", name: "Bulk Two", provider: "openai" },
        ],
      }),
      { status: 200 },
    );
  }
  if (!/^\/api\/workspaces\/[^/]+\/move$/.test(href))
    throw new Error(`Unexpected fixture fetch: ${href}`);
  const body = JSON.parse(init.body);
  window.fixture.requests.push({ url: href, ...body });
  const issue = { ...body.items[0], code: "NAME_TAKEN", message: "taken" };
  if (body.preview) {
    const conflicts = mode === "preview-conflict" ? [issue] : [];
    const warnings =
      mode === "warning" ? [{ ...issue, code: "GRANTS_REVOKED", message: "grants revoked" }] : [];
    return new Response(JSON.stringify({ conflicts, warnings }), { status: 200 });
  }
  if (mode === "error")
    return new Response(JSON.stringify({ error: "Something broke" }), { status: 500 });
  if (mode === "confirm-409" && !window.fixture.retried409) {
    window.fixture.retried409 = true;
    return new Response(
      JSON.stringify({ error: "Move has conflicts", code: "move_conflict", conflicts: [issue] }),
      { status: 409 },
    );
  }
  return new Response(JSON.stringify({ moved: body.items }), { status: 200 });
};

const GENERIC = new Set([
  "delayed",
  "immediate",
  "immediate-flush",
  "last",
  "cancel",
  "escape",
  "preview-conflict",
  "confirm-409",
  "error",
  "warning",
]);
function App() {
  if (GENERIC.has(mode)) return <ListFixture />;
  if (mode === "combo-real") return <ComboFixture />;
  if (mode === "connection-real") return <ConnectionFixture />;
  if (mode === "node-real") return <NodeFixture />;
  if (["alias", "custom", "compatible", "disabled", "model-row"].includes(mode))
    return <ModelsFixture entry={mode} />;
  if (mode === "api-key-real") return <ApiKeysFixture />;
  if (mode === "bulk") return <BulkFixture />;
  throw new Error(`Unknown fixture mode: ${mode}`);
}
createRoot(document.getElementById("root")).render(<App />);
