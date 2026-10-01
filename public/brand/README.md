# Brand assets (tokenhop)

Copied from the [tokenhop/resources](https://github.com/tokenhop/resources) repo,
which is the source of truth for the logo:

- `mark.svg` — coral tile + ink glyph (the `BrandMark` component inlines these paths)
- `lockup.svg` — mark + wordmark (dark ground)
- `mono.svg` — mono glyph (tray template icon source)
- `favicon.svg`, `favicon.ico` — the mark at 16/32/48
- `icons/icon-192.svg`, `icons/icon-512.svg` — maskable-safe PWA icons (glyph inside the central 80% safe zone)

Rasters in `cli/src/cli/tray/` and `images/` are committed.

<!-- ponytail: `sharp` is only a transitive optional dep of next here, so this
repo doesn't rasterize. Regenerate PNGs once with resources' source/rasterize.mjs
(chromium), then rebuild the .ico files with `node scripts/brand-ico.mjs`. Add a
rasterize script in-repo only if sharp becomes a declared dependency. -->
