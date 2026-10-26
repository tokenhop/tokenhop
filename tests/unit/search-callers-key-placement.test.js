// YAN-1574: search keys must travel in headers, never the URL — proxy relays log
// pathname+search (x-relay-path), so a key in the query string leaks to the relay.
import { describe, expect, it } from "vitest";
import { buildSearchRequest } from "../../open-sse/handlers/search/callers.js";

const KEY = "secret-key-yan-1574";

describe("search caller key placement", () => {
  it("Google Programmable Search sends x-goog-api-key and keeps the key out of the URL", () => {
    const { url, init } = buildSearchRequest(
      { id: "google-pse", baseUrl: "https://customsearch.googleapis.com/customsearch/v1" },
      { query: "tokenhop", maxResults: 5, token: KEY, providerOptions: { cx: "cx-1" } },
    );

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://customsearch.googleapis.com/customsearch/v1",
    );
    expect(parsed.searchParams.get("cx")).toBe("cx-1");
    expect(parsed.searchParams.get("q")).toBe("tokenhop");
    expect(parsed.searchParams.has("key")).toBe(false);
    expect(url).not.toContain(KEY);
    expect(init.headers["x-goog-api-key"]).toBe(KEY);
  });

  it("SearchAPI sends a Bearer token and keeps the key out of the URL", () => {
    const { url, init } = buildSearchRequest(
      { id: "searchapi", baseUrl: "https://www.searchapi.io/api/v1/search" },
      { query: "tokenhop", maxResults: 5, token: KEY, searchType: "news" },
    );

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://www.searchapi.io/api/v1/search");
    expect(parsed.searchParams.get("engine")).toBe("google_news");
    expect(parsed.searchParams.get("q")).toBe("tokenhop");
    expect(parsed.searchParams.has("api_key")).toBe(false);
    expect(url).not.toContain(KEY);
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
  });
});
