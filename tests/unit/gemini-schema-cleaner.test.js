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
});
