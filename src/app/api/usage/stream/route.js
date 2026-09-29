import { statsEmitter, getActiveRequests } from "@/lib/usageDb";
import { buildLivePayload } from "@/lib/usage/livePayload";

export const dynamic = "force-dynamic";

// YAN-407 stream diet: one slim frame per event (connect, "update", "pending"),
// built from the in-memory tracker — the full-history stats aggregate is never
// computed here. Cleanup runs on send failure, cancel and request abort.
export async function GET(request) {
  const encoder = new TextEncoder();
  const state = { closed: false, keepalive: null, send: null };

  const cleanup = () => {
    state.closed = true;
    if (state.send) {
      statsEmitter.off("update", state.send);
      statsEmitter.off("pending", state.send);
    }
    clearInterval(state.keepalive);
  };

  const stream = new ReadableStream({
    async start(controller) {
      state.send = async () => {
        if (state.closed) return;
        try {
          const payload = buildLivePayload(await getActiveRequests());
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
