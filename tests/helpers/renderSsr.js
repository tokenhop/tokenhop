// Real render harness for dashboard client components (YAN-374). Loads source
// through a Vite SSR server with SWC compiling JSX (same compiler as next) and
// renders to static markup: hooks run for real, effects do not (SSR), so use
// it for "what does this principal see" and unit-test fetch gates separately.
import { createServer } from "vite";
import { resolve } from "node:path";
import { transformSync } from "next/dist/build/swc";

const root = resolve(import.meta.dirname, "../..");
const here = import.meta.dirname;

export async function createSsr() {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: {
      alias: [
        { find: /^zustand$/, replacement: resolve(here, "mocks/zustand.js") },
        {
          find: /^@\/shared\/hooks\/useAuthStatus$/,
          replacement: resolve(here, "mocks/useAuthStatus.js"),
        },
        { find: /^open-sse\//, replacement: `${resolve(root, "open-sse")}/` },
        { find: /^@\//, replacement: `${resolve(root, "src")}/` },
      ],
    },
    plugins: [
      {
        name: "swc-jsx",
        enforce: "pre",
        transform(code, id) {
          const file = id.split("?")[0];
          if (!file.includes("/src/") || !file.endsWith(".js")) return null;
          const out = transformSync(code, {
            filename: file,
            jsc: {
              parser: { syntax: "ecmascript", jsx: true },
              transform: { react: { runtime: "automatic" } },
              target: "es2022",
            },
            module: { type: "es6" },
          });
          return { code: out.code, map: null };
        },
      },
      {
        // brand/index.cjs is CommonJS; the SSR runner has no `module`.
        name: "cjs-to-esm",
        enforce: "pre",
        transform(code, id) {
          const f2 = id.split("?")[0];
          if (!f2.endsWith(".cjs") && !f2.endsWith(".js")) return null;
          if (!code.includes("module.exports")) return null;
          // `module.exports = { a, b }` -> named ESM exports; anything else -> default.
          const named = code.replace(
            /module\.exports\s*=\s*\{([^}]*)\}\s*;?/g,
            (_m, names) =>
              `export { ${names.replace(/\s+/g, " ").trim()} }; export default { ${names} };`,
          );
          return { code: named.replace(/module\.exports\s*=/g, "export default"), map: null };
        },
      },
    ],
  });
  return { load: (path) => server.ssrLoadModule(path), close: () => server.close() };
}
