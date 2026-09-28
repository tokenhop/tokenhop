import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Text node stub under a plain parent element. */
function text(value) {
  const parent = { tagName: "SPAN", className: "", parentElement: null, hasAttribute: () => false };
  return { nodeType: 3, nodeValue: value, parentElement: parent };
}

/** Element stub whose subtree is a flat list of text nodes. */
function element(texts) {
  return {
    nodeType: 1,
    tagName: "DIV",
    className: "",
    parentElement: null,
    texts,
    hasAttribute: () => false,
    querySelectorAll: () => [],
  };
}

let walked;
let observers;

function installDom(locale) {
  walked = [];
  observers = [];
  const body = element([]);
  vi.stubGlobal("window", {});
  vi.stubGlobal("Node", { ELEMENT_NODE: 1, TEXT_NODE: 3 });
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
  vi.stubGlobal("document", {
    cookie: `locale=${locale}`,
    body,
    createTreeWalker(root) {
      walked.push(root);
      const queue = [...root.texts];
      return { nextNode: () => queue.shift() ?? null };
    },
  });
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        observers.push(this);
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    },
  );
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ Hello: "Hola", Save: "Guardar" }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return { body, fetchMock };
}

async function loadRuntime() {
  vi.resetModules();
  return import("../../src/i18n/runtime.js");
}

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.unstubAllGlobals());

describe("runtime i18n lifecycle", () => {
  it("does no fetch, walk or observation in English", async () => {
    const { fetchMock } = installDom("en");
    const runtime = await loadRuntime();
    await runtime.initRuntimeI18n();
    await runtime.reloadTranslations();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(walked).toHaveLength(0);
    expect(observers).toHaveLength(0);
  });

  it("reuses a cached locale map across reloads", async () => {
    const { fetchMock } = installDom("es");
    const runtime = await loadRuntime();
    await runtime.initRuntimeI18n();
    await runtime.reloadTranslations();
    await runtime.reloadTranslations();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(observers).toHaveLength(1);
  });

  it("translates only mutated subtrees and edited text", async () => {
    installDom("es");
    const runtime = await loadRuntime();
    await runtime.initRuntimeI18n();
    walked.length = 0;

    const added = element([text("Hello")]);
    observers[0].callback([{ type: "childList", addedNodes: [added] }]);
    expect(walked).toEqual([added]);
    expect(added.texts[0].nodeValue).toBe("Hola");

    // React replaced the text in place: new source copy, not our translation.
    added.texts[0].nodeValue = "Save";
    observers[0].callback([{ type: "characterData", target: added.texts[0] }]);
    expect(added.texts[0].nodeValue).toBe("Guardar");
  });

  it("ignores a locale load superseded by a newer switch", async () => {
    const { body, fetchMock } = installDom("es");
    const node = text("Hello");
    body.texts.push(node);
    let resolveFetch;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => (resolveFetch = resolve)));
    const runtime = await loadRuntime();
    const init = runtime.initRuntimeI18n();

    Object.assign(document, { cookie: "locale=en" });
    await runtime.reloadTranslations();
    resolveFetch({ ok: true, json: async () => ({ Hello: "Hola" }) });
    await init;

    expect(node.nodeValue).toBe("Hello");
    expect(observers).toHaveLength(0);
  });

  it("restores English once, then stops observing", async () => {
    const { body } = installDom("es");
    const node = text("Hello");
    body.texts.push(node);
    const runtime = await loadRuntime();
    await runtime.initRuntimeI18n();
    expect(node.nodeValue).toBe("Hola");

    Object.assign(document, { cookie: "locale=en" });
    walked.length = 0;
    await runtime.reloadTranslations();
    expect(node.nodeValue).toBe("Hello");
    expect(walked).toEqual([body]);
    expect(observers[0].disconnected).toBe(true);

    walked.length = 0;
    await runtime.reloadTranslations();
    expect(walked).toHaveLength(0);
  });
});
