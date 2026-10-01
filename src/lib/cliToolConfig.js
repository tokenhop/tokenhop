import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { parseJSONC, parseTOML } from "confbox";
import { ACTIVE } from "@/shared/brand";

// Thrown when a user's CLI-tool config file exists but can't be parsed. Write
// paths must surface this instead of falling back to `{}` — writing `{}` back
// wipes the user's own settings (MCP servers, providers, trust entries, …).
export class ConfigParseError extends Error {
  constructor(filePath, cause) {
    super(
      `Could not parse ${filePath}: ${cause?.message || cause}. Fix or remove the file, then retry — ${ACTIVE.name} will not overwrite it.`,
    );
    this.name = "ConfigParseError";
    this.filePath = filePath;
  }
}

const readConfigFile = async (filePath, parse) => {
  let content;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!content.trim()) return null;
  try {
    return parse(content);
  } catch (error) {
    throw new ConfigParseError(filePath, error);
  }
};

// JSON config (comments and trailing commas tolerated). null when missing/empty;
// throws ConfigParseError when present but unparseable or not the expected
// top-level shape ("object" by default, or "array").
export const readJsonConfig = (filePath, expected = "object") =>
  readConfigFile(filePath, (content) => {
    const value = parseJSONC(content, { allowTrailingComma: true });
    if (value === null) return null;
    const isArray = Array.isArray(value);
    if (expected === "array" ? !isArray : isArray || typeof value !== "object") {
      throw new Error(`expected a JSON ${expected}`);
    }
    return value;
  });

// TOML config. Same contract as readJsonConfig.
export const readTomlConfig = (filePath) => readConfigFile(filePath, parseTOML);

// 422 response for a ConfigParseError, else null (caller keeps its own 500 path).
export const configErrorResponse = (error) =>
  error instanceof ConfigParseError
    ? NextResponse.json({ error: error.message }, { status: 422 })
    : null;
