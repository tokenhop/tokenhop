// Dev-only regeneration: node scripts/logos-webp.mjs. PNGs remain the source files.
import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const providersDir = fileURLToPath(new URL("../public/providers/", import.meta.url));
const pngs = (await readdir(providersDir)).filter((name) => name.endsWith(".png"));
let before = 0;
let after = 0;

for (const name of pngs) {
  const source = join(providersDir, name);
  before += (await stat(source)).size;
  const webp = await sharp(source)
    .resize(112, 112, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 80, alphaQuality: 80, effort: 6, smartSubsample: true })
    .toBuffer();
  await writeFile(join(providersDir, name.replace(/\.png$/, ".webp")), webp);
  after += webp.length;
}

console.log(`${pngs.length} logos: PNG ${before} bytes; WebP ${after} bytes`);
