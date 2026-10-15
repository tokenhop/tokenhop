import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Compile the REAL src/app/globals.css (Tailwind v4 via the repo's installed
 * @tailwindcss/postcss) so responsive utilities such as `hidden md:block` /
 * `md:hidden` have their production meaning. No new dependencies.
 */
export async function compileAppCss(root) {
  const require = createRequire(resolve(root, "package.json"));
  const postcss = (await import(pathToFileURL(require.resolve("postcss")).href)).default;
  const tailwind = (await import(pathToFileURL(require.resolve("@tailwindcss/postcss")).href))
    .default;
  const from = resolve(root, "src/app/globals.css");
  const result = await postcss([tailwind({ base: root })]).process(await readFile(from, "utf8"), {
    from,
  });
  return result.css;
}
