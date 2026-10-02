// Regression: property/parameter names must never be treated as schema keywords.
// Recursion walks name maps (properties, $defs, …) by VALUE, so a tool param named
// "format", "const", or "x-trace" is preserved while real keywords still get stripped.
import { describe, it, expect } from "vitest";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";

describe("cleanJSONSchemaForAntigravity - name maps", () => {
  it("keeps params whose names collide with schema keywords", () => {
    const result = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        url: { type: "string" },
        format: { type: "string", enum: ["text", "markdown", "html"] },
        title: { type: "string" },
        default: { type: "string" },
        const: { type: "string" },
        examples: { type: "array", items: { type: "string" } },
        "x-trace": { type: "string" },
      },
      required: ["url", "format", "const"],
    });

    expect(Object.keys(result.properties)).toEqual([
      "url",
      "format",
      "title",
      "default",
      "const",
      "examples",
      "x-trace",
    ]);
    expect(result.required).toEqual(["url", "format", "const"]);
    // convertConstToEnum must not fire on the properties MAP itself
    expect(result.properties.const).toEqual({ type: "string" });
    expect(result.properties).not.toHaveProperty("enum");
    expect(result.properties).not.toHaveProperty("type");
    // real keywords on real schemas are still processed
    expect(result.properties.format.enum).toEqual(["text", "markdown", "html"]);
  });

  it("still strips real unsupported keywords from schemas", () => {
    const result = cleanJSONSchemaForAntigravity({
      type: "object",
      title: "Root",
      properties: {
        link: { type: "string", format: "uri", default: "x" },
      },
    });

    expect(result).not.toHaveProperty("title");
    expect(result.properties.link).toEqual({ type: "string" });
  });

  it("does not add type when a param is named 'properties'", () => {
    const result = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        properties: { type: "string" },
      },
    });

    expect(Object.keys(result.properties)).toEqual(["properties"]);
    expect(result.properties.properties).toEqual({ type: "string" });
  });

  it("still deletes name-map keywords ($defs, patternProperties, …) from schemas", () => {
    const result = cleanJSONSchemaForAntigravity({
      type: "object",
      $defs: { a: { type: "string" } },
      definitions: { b: { type: "string" } },
      patternProperties: { "^x": { type: "string" } },
      dependentSchemas: { c: { type: "string" } },
      properties: { name: { type: "string", const: "n" } },
    });

    expect(result).not.toHaveProperty("$defs");
    expect(result).not.toHaveProperty("definitions");
    expect(result).not.toHaveProperty("patternProperties");
    expect(result).not.toHaveProperty("dependentSchemas");
    // a real `const` keyword on a real schema still converts to enum
    expect(result.properties.name).toEqual({ type: "string", enum: ["n"] });
  });

  // YAN-667 — allowlist: unlisted keywords ($id, strict, errorMessage,
  // cache_control, x-*) must never reach Google; one occurrence rejects the
  // whole request with "Unknown name ...: Cannot find field"
  it("drops unlisted keywords at every level while keeping supported ones", () => {
    const result = cleanJSONSchemaForAntigravity({
      type: "object",
      $id: "https://example.com/root",
      properties: {
        a: { type: "string", strict: true, minLength: 1 },
        b: {
          type: "array",
          cache_control: { type: "ephemeral" },
          items: { type: "string", errorMessage: "bad", pattern: "^x" },
        },
        style: { type: "object", x_cursor: 1, properties: { gap: { type: "number" } } },
      },
    });

    expect(JSON.stringify(result)).not.toContain('"$id"');
    expect(result.properties.a).toEqual({ type: "string" });
    expect(result.properties.b).toEqual({
      type: "array",
      items: { type: "string", pattern: "^x" },
    });
    expect(result.properties.style).toEqual({
      type: "object",
      properties: { gap: { type: "number" } },
    });
  });
});
