import { describe, expect, it } from "vitest";
import {
  maskProxyUrl,
  parseBatchImport,
  parseProxyLine,
  selectionReducer,
  validateProxyUrl,
} from "../../src/shared/utils/proxyPools.js";

describe("maskProxyUrl", () => {
  it("strips user:pass from http URLs", () => {
    expect(maskProxyUrl("http://user:pass@127.0.0.1:7897")).toBe("http://127.0.0.1:7897");
  });

  it("strips credentials for https and socks5 schemes", () => {
    expect(maskProxyUrl("https://u:p@relay.example/x")).toBe("https://relay.example/x");
    expect(maskProxyUrl("socks5://u:p@127.0.0.1:1080")).toBe("socks5://127.0.0.1:1080");
  });

  it("leaves credential-less URLs and IPv6 hosts intact", () => {
    expect(maskProxyUrl("http://127.0.0.1:7897")).toBe("http://127.0.0.1:7897");
    expect(maskProxyUrl("socks5://user:pw@[::1]:1080")).toBe("socks5://[::1]:1080");
    expect(maskProxyUrl("http://[2001:db8::1]:3128")).toBe("http://[2001:db8::1]:3128");
  });

  it("handles username-only credentials and query strings", () => {
    expect(maskProxyUrl("http://user@host:8080")).toBe("http://host:8080");
    expect(maskProxyUrl("http://u:p@host:8080/path?a=b")).toBe("http://host:8080/path?a=b");
  });

  it("returns empty/unparseable input unchanged without throwing", () => {
    expect(maskProxyUrl("")).toBe("");
    expect(maskProxyUrl("   ")).toBe("");
    expect(maskProxyUrl("not a url")).toBe("not a url");
  });
});

describe("validateProxyUrl", () => {
  it("accepts http/https/socks schemes", () => {
    for (const url of [
      "http://127.0.0.1:7897",
      "https://relay.workers.dev",
      "socks5://127.0.0.1:1080",
    ]) {
      expect(validateProxyUrl(url)).toBeNull();
    }
  });

  it("rejects empty, bad schemes and injection characters", () => {
    expect(validateProxyUrl("")).toBe("Proxy URL is required");
    expect(validateProxyUrl("ftp://host/x")).toBe("Use an http, https or socks proxy URL");
    expect(validateProxyUrl("notaurl")).toBe("Enter a valid proxy URL");
    expect(validateProxyUrl("http://host/\n evil")).toBe("Proxy URL contains invalid characters");
  });
});

describe("parseProxyLine / parseBatchImport", () => {
  it("parses full URLs with generated names", () => {
    expect(parseProxyLine("http://user:pass@127.0.0.1:7897")).toEqual({
      proxyUrl: "http://user:pass@127.0.0.1:7897/",
      name: "Imported 127.0.0.1:7897",
    });
  });

  it("parses host:port:user:pass lines", () => {
    const out = parseProxyLine("127.0.0.1:7897:user:pass");
    expect(out.name).toBe("Imported 127.0.0.1:7897");
    expect(out.proxyUrl).toContain("user:pass@127.0.0.1:7897");
  });

  it("returns null for blank lines and throws for junk", () => {
    expect(parseProxyLine("   ")).toBeNull();
    expect(() => parseProxyLine("just-a-host")).toThrow("Unsupported format");
    expect(() => parseProxyLine("a:b:c")).toThrow("Unsupported format");
    expect(() => parseProxyLine(":::")).toThrow("Invalid host:port:user:pass format");
  });

  it("parses a textarea into entries plus per-line errors", () => {
    const { entries, errors } = parseBatchImport(
      "http://u:p@127.0.0.1:7897\njunk line\n\n1.2.3.4:8080:a:b",
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].lineNumber).toBe(1);
    expect(entries[1].lineNumber).toBe(4);
    expect(errors).toEqual(["Line 2: Unsupported format"]);
  });
});

describe("selectionReducer", () => {
  it("toggles, selects all, prunes and clears", () => {
    let state = selectionReducer(undefined, { type: "toggle", id: "a" });
    expect(state.selectedIds).toEqual(["a"]);
    state = selectionReducer(state, { type: "toggle", id: "b" });
    state = selectionReducer(state, { type: "toggle", id: "a" });
    expect(state.selectedIds).toEqual(["b"]);
    state = selectionReducer(state, { type: "select-all", ids: ["a", "b"] });
    expect(state.selectedIds).toEqual(["a", "b"]);
    state = selectionReducer(state, { type: "prune", ids: ["b"] });
    expect(state.selectedIds).toEqual(["b"]);
    state = selectionReducer(state, { type: "clear" });
    expect(state.selectedIds).toEqual([]);
  });

  it("tracks health-check progress lifecycle", () => {
    let state = selectionReducer(undefined, { type: "check-start", total: 3 });
    expect(state.checking).toBe(true);
    expect(state.progress).toEqual({ current: 0, total: 3 });
    state = selectionReducer(state, { type: "check-progress", current: 2 });
    expect(state.progress).toEqual({ current: 2, total: 3 });
    state = selectionReducer(state, { type: "check-done" });
    expect(state.checking).toBe(false);
    expect(state.progress).toBeNull();
  });
});
