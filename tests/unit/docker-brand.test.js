import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { BRAND, DEFAULT_BRAND_ID, LEGACY } = require("../../src/shared/brand/index.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

describe("Docker brand (YAN-337)", () => {
  const dockerfile = read("Dockerfile");

  it("labels the image with the build's brand, falling back to the default brand", () => {
    const title = dockerfile.match(
      /org\.opencontainers\.image\.title="\$\{NEXT_PUBLIC_BRAND:-([^}]+)\}"/,
    );
    expect(title?.[1]).toBe(DEFAULT_BRAND_ID);
    expect(dockerfile).toContain(`org.opencontainers.image.source="${BRAND.repoUrl}"`);
  });

  it("links both the tokenhop and the legacy root data dirs to the data home", () => {
    expect(dockerfile).toContain(`ln -sf /app/data-home /root/.${BRAND.dataDirName}`);
    expect(dockerfile).toContain(`ln -sf /app/data-home /root/.${LEGACY.dataDirName}`);
    expect(dockerfile).toContain("ENV DATA_DIR=/app/data");
  });

  // Renaming a named volume makes Docker create a new, empty one.
  it.each(["compose.yml", "start.sh"])("%s keeps the existing data volume", (file) => {
    expect(read(file)).toContain(`${LEGACY.dataDirName}-data`);
  });
});
