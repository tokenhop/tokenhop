export const RELAY_TEMPLATE_VERSION = 2;
export const RELAY_TEMPLATE_VERSION_HEADER = "x-relay-version";

// Keep the version literal in the standalone sources: deployed relays cannot
// import application modules. proxyFetch mirrors these two small constants.
const VERSION_HEADERS_SOURCE = `
const relayVersionHeaders = (headers) => {
  const out = new Headers(headers);
  out.set("${RELAY_TEMPLATE_VERSION_HEADER}", "${RELAY_TEMPLATE_VERSION}");
  return out;
};
`;

// Relay function source deployed to Vercel
// Forwards requests to target URL specified in x-relay-target header
export const VERCEL_RELAY_CODE = `
${VERSION_HEADERS_SOURCE}
export const config = { runtime: "edge" };

export default async function handler(req) {
  const target = req.headers.get("x-relay-target");
  const relayPath = req.headers.get("x-relay-path") || "/";
  const relayRedirect = req.headers.get("x-relay-redirect");
  if (!target) {
    return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
      status: 400,
      headers: relayVersionHeaders({ "content-type": "application/json" }),
    });
  }

  const targetUrl = target.replace(/\\/$/, "") + relayPath;

  const headers = new Headers(req.headers);
  headers.delete("x-relay-target");
  headers.delete("x-relay-path");
  headers.delete("x-relay-redirect");
  headers.delete("host");

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      duplex: "half",
      // Return a 3xx unchanged when the caller must not follow redirects; the gateway's own fetch then applies its mode ("error" fails, "manual" sees the 3xx).
      redirect: relayRedirect === "error" || relayRedirect === "manual" ? "manual" : "follow",
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: relayVersionHeaders(response.headers),
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 502,
      headers: relayVersionHeaders({ "content-type": "application/json" }),
    });
  }
}
`;

// Relay worker source code deployed to Cloudflare
export const CLOUDFLARE_RELAY_CODE = `
${VERSION_HEADERS_SOURCE}
export default {
  async fetch(request, env, ctx) {
    const target = request.headers.get("x-relay-target");
    const relayPath = request.headers.get("x-relay-path") || "/";
    const relayRedirect = request.headers.get("x-relay-redirect");

    if (!target) {
      return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
        status: 400,
        headers: relayVersionHeaders({ "content-type": "application/json" }),
      });
    }

    const targetUrl = target.replace(/\\/$/, "") + relayPath;
    const newRequestInit = {
      method: request.method,
      headers: new Headers(request.headers),
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      newRequestInit.body = request.body;
      newRequestInit.duplex = "half";
    }

    newRequestInit.headers.delete("x-relay-target");
    newRequestInit.headers.delete("x-relay-path");
    newRequestInit.headers.delete("x-relay-redirect");
    newRequestInit.headers.delete("host");

    // Return a 3xx unchanged when the caller must not follow redirects; the gateway's own fetch then applies its mode ("error" fails, "manual" sees the 3xx).
    newRequestInit.redirect =
      relayRedirect === "error" || relayRedirect === "manual" ? "manual" : "follow";

    try {
      const response = await fetch(targetUrl, newRequestInit);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: relayVersionHeaders(response.headers),
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 502,
        headers: relayVersionHeaders({ "content-type": "application/json" }),
      });
    }
  },
};
`;

// Relay source deployed to Deno Deploy
export const DENO_RELAY_CODE = `Deno.serve(async (request) => {
${VERSION_HEADERS_SOURCE}
  const target = request.headers.get("x-relay-target");
  const relayPath = request.headers.get("x-relay-path") || "/";
  const relayRedirect = request.headers.get("x-relay-redirect");

  if (!target) {
    return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
      status: 400,
      headers: relayVersionHeaders({ "content-type": "application/json" }),
    });
  }

  const targetUrl = target.replace(/\\/$/, "") + relayPath;
  const newHeaders = new Headers(request.headers);
  newHeaders.delete("x-relay-target");
  newHeaders.delete("x-relay-path");
  newHeaders.delete("x-relay-redirect");
  newHeaders.delete("host");

  const init = {
    method: request.method,
    headers: newHeaders,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  // Return a 3xx unchanged when the caller must not follow redirects; the gateway's own fetch then applies its mode ("error" fails, "manual" sees the 3xx).
  init.redirect = relayRedirect === "error" || relayRedirect === "manual" ? "manual" : "follow";

  try {
    const response = await fetch(targetUrl, init);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: relayVersionHeaders(response.headers),
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 502,
      headers: relayVersionHeaders({ "content-type": "application/json" }),
    });
  }
});`;
