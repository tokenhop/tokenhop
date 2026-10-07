import { statsEmitter, getLiveSnapshot } from "@/lib/usageDb";
import { buildLivePayload } from "@/lib/usage/livePayload";
import { usageScope } from "@/lib/usage/scope.js";

export const dynamic = "force-dynamic";

// YAN-407 stream diet: one slim frame per event (connect, "update", "pending"),
// built from the in-memory snapshot — the full-history stats aggregate is never
// computed here. Cleanup runs on send failure, cancel and request abort.
export async function GET(request) {
  // Resolve the subscriber's scope once; every frame is filtered by workspace.
  const scope = await usageScope(request);
  if (scope instanceof Response) return scope;
  const liveScope = scope ? { workspaceId: scope.workspaceId } : null;
  const encoder = new TextEncoder();
  const state = {
    closed: false,
    clientCancelled: false,
    keepalive: null,
    send: null,
    stalled: 0,
    abortCleanup: null,
    controller: null,
  };

  const cleanup = () => {
    if (state.closed) return;
    state.closed = true;
    if (state.send) {
      statsEmitter.off("update", state.send);
      statsEmitter.off("pending", state.send);
    }
    clearInterval(state.keepalive);
    if (state.abortCleanup) {
      request.signal.removeEventListener("abort", state.abortCleanup);
      state.abortCleanup = null;
    }
    try {
      // Client-cancel close is already torn down by cancel(); closing again
      // throws, so only close here for server-side cleanup.
      if (!state.clientCancelled) state.controller?.close();
    } catch {}
  };

  const stream = new ReadableStream({
    async start(controller) {
      state.controller = controller;
      state.send = async () => {
        if (state.closed) return;
        try {
          const payload = buildLivePayload(await getLiveSnapshot(liveScope));
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            if (++state.stalled >= 3) {
              cleanup();
              return;
            }
          } else {
            state.stalled = 0;
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          cleanup();
        }
      };

      // One frame on connect so a fresh client paints live fields immediately.
      await state.send();
      if (state.closed) return;

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.send);
      state.abortCleanup = cleanup;
      request.signal.addEventListener("abort", cleanup);

      state.keepalive = setInterval(() => {
        if (state.closed) {
          clearInterval(state.keepalive);
          return;
        }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 25000);
    },

    cancel() {
      state.clientCancelled = true;
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
