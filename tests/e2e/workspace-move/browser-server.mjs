import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileAppCss } from "./css.mjs";

// Derive from the runner's source, never node_modules (which may be symlinked).
export const root = fileURLToPath(new URL("../../../", import.meta.url));
const here = fileURLToPath(new URL("./", import.meta.url));

export async function startServer(scratch) {
  const require = createRequire(resolve(root, "tests/package.json"));
  let viteEntry;
  try {
    viteEntry = require.resolve("vite");
  } catch (error) {
    throw new Error(
      `vite must resolve via tests/node_modules (run: cd tests && npm install): ${error.message}`,
    );
  }
  const { createServer } = await import(viteEntry);
  const { transformSync } = await import(require.resolve("next/dist/build/swc/index.js"));
  const appCss = await compileAppCss(root);
  const barrel = await readFile(resolve(root, "src/shared/components/index.js"), "utf8");
  const exports = new Map();
  for (const match of barrel.matchAll(/export\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)) {
    for (const specifier of match[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const [original, local = original] = specifier.split(/\s+as\s+/);
      exports.set(local, { original, path: `@/shared/components/${match[2].slice(2)}` });
    }
  }
  const server = await createServer({
    root,
    configFile: false,
    envDir: false,
    logLevel: "warn",
    appType: "custom",
    cacheDir: resolve(scratch, "vite-cache"),
    define: { "process.env.NEXT_PUBLIC_BRAND": JSON.stringify("tokenhop") },
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      ws: false,
      fs: { allow: [root, resolve(root, "node_modules"), resolve(root, "tests/node_modules")] },
    },
    optimizeDeps: {
      noDiscovery: true,
      include: ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "prop-types"],
    },
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: [
        { find: /^@\/shared\/hooks\/useAuthStatus$/, replacement: resolve(here, "auth-mock.mjs") },
        { find: /^os$/, replacement: resolve(here, "os-mock.mjs") },
        { find: /^next\/link$/, replacement: resolve(here, "next-mock.jsx") },
        { find: /^@\//, replacement: `${root}src/` },
        { find: /^open-sse\//, replacement: `${root}open-sse/` },
      ],
    },
    plugins: [
      {
        // Resolve only requested barrel exports to their REAL modules. This avoids
        // unrelated dashboard routes/Next server internals; no UI replacement.
        name: "fixture-direct-barrel",
        enforce: "pre",
        transform(code, id) {
          if (!id.startsWith(root) || id.includes("node_modules")) return null;
          return {
            code: code.replace(
              /import\s*\{([^}]+)\}\s*from\s*["']@\/shared\/components["'];?/g,
              (_, names) =>
                names
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map((name) => {
                    const entry = exports.get(name);
                    if (!entry) throw new Error(`Unmapped real component export: ${name}`);
                    return entry.original === "default"
                      ? `import ${name} from "${entry.path}";`
                      : `import { ${entry.original} as ${name} } from "${entry.path}";`;
                  })
                  .join("\n"),
            ),
            map: null,
          };
        },
      },
      {
        name: "fixture-html",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (req.url === "/fixture.css") {
              res.setHeader("Content-Type", "text/css");
              return res.end(appCss);
            }
            if (!req.url?.startsWith("/fixture")) return next();
            const html = await vite.transformIndexHtml(
              req.url,
              `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Workspace move component browser tests</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/tests/e2e/workspace-move/${new URLSearchParams(req.url.split("?")[1]).get("entry") || "fixture.jsx"}"></script></body></html>`,
            );
            res.setHeader("Content-Type", "text/html");
            res.end(html);
          });
        },
      },
      {
        name: "fixture-cjs",
        enforce: "pre",
        transform(code, id) {
          if (
            id.includes("node_modules") ||
            !/\.(cjs|js)$/.test(id) ||
            !code.includes("module.exports")
          )
            return null;
          const named = code.replace(
            /module\.exports\s*=\s*\{([^}]*)\}\s*;?/g,
            (_, names) => `export { ${names} }; export default { ${names} };`,
          );
          return { code: named.replace(/module\.exports\s*=/g, "export default"), map: null };
        },
      },
      {
        name: "fixture-swc",
        enforce: "pre",
        transform(code, id) {
          const file = id.split("?")[0];
          if (!file.startsWith(root) || file.includes("node_modules") || !/\.(js|jsx)$/.test(file))
            return null;
          return {
            code: transformSync(code, {
              filename: file,
              jsc: {
                parser: { syntax: "ecmascript", jsx: true },
                transform: { react: { runtime: "automatic" } },
                target: "es2022",
              },
              module: { type: "es6" },
            }).code,
            map: null,
          };
        },
      },
    ],
  });
  await server.listen();
  return { url: server.resolvedUrls.local[0], close: () => server.close() };
}
