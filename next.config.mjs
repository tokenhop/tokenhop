import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import brand from "./src/shared/brand/index.cjs";

const projectRoot = dirname(fileURLToPath(import.meta.url));
// CLI bundling needs workspace root so tracing includes hoisted node_modules (slim ~50MB).
// Docker / default uses projectRoot so server.js lands at /app/server.js (not nested).
const tracingRoot =
  process.env.NEXT_TRACING_ROOT_MODE === "workspace" ? join(projectRoot, "..") : projectRoot;
const proxyClientMaxBodySize = brand.readEnv("PROXY_CLIENT_MAX_BODY_SIZE") || "128mb";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Stop `next dev` from rewriting AGENTS.md/CLAUDE.md with its agent-rules block.
  agentRules: false,
  // `next dev` blocks cross-origin HMR websockets (e.g. tailscale serve at
  // https://<host>.ts.net) unless the origin is allow-listed here.
  allowedDevOrigins: ["ubdevsrv.azules-celsius.ts.net", "localhost"],
  distDir: process.env.NEXT_DIST_DIR || ".next",
  output: "standalone",
  // `open` must stay external. It derives its own directory from `import.meta.url`, and
  // webpack replaces that with the absolute path of the BUILD machine as a string literal.
  // A release built on macOS therefore ships `file:///Users/.../open/index.js`, which
  // `fileURLToPath` rejects on Windows ("File URL path must be absolute" — no drive
  // letter). That throw happens at module scope, so every consumer of `open` dies on
  // import — including xAI/Grok token refresh, which loads the OAuth service that imports
  // it. Keeping it external preserves the real `import.meta.url` at runtime.
  serverExternalPackages: ["better-sqlite3", "sql.js", "node:sqlite", "bun:sqlite", "open"],
  turbopack: {
    root: tracingRoot,
  },
  outputFileTracingRoot: tracingRoot,
  // Gateway-hosted agent skills are read from disk by /skills/[...slug]; trace them into standalone.
  outputFileTracingIncludes: {
    "/skills/[...slug]": ["./skills/**/*.md"],
  },
  outputFileTracingExcludes: {
    "*": ["./gitbook/**/*"],
  },
  images: {
    unoptimized: true,
  },
  env: {},
  experimental: {
    // #1529/#1572: LLM clients can send long context or base64 image payloads through /v1 rewrites.
    proxyClientMaxBodySize,
    // Cache fetch responses across HMR refreshes for faster dev reloads.
    serverComponentsHmrCache: true,
    // Tree-shake heavy barrel imports to cut compile + bundle size
    optimizePackageImports: ["@dnd-kit/core", "@dnd-kit/sortable", "marked"],
  },
  webpack: (config, { isServer }) => {
    // Ignore fs/path modules in browser bundle
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
      };
    }
    // Exclude non-source dirs from watcher to reduce inotify load
    config.watchOptions = {
      ...config.watchOptions,
      aggregateTimeout: 300,
      ignored:
        /[\\/](node_modules|\.git|logs|\.next|\.next-cli-build|gitbook|cli|open-sse\.old|tests|docs)[\\/]/,
    };
    return config;
  },
  async headers() {
    return [
      {
        source: "/providers/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
          },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/v1/v1/:path*",
        destination: "/api/v1/:path*",
      },
      {
        source: "/v1/v1",
        destination: "/api/v1",
      },
      {
        source: "/codex/:path*",
        destination: "/api/v1/responses",
      },
      {
        source: "/responses",
        destination: "/api/v1/responses",
      },
      {
        source: "/infill",
        destination: "/api/v1/infill",
      },
      {
        source: "/infill/",
        destination: "/api/v1/infill",
      },
      {
        source: "/v1beta/:path*",
        destination: "/api/v1beta/:path*",
      },
      {
        source: "/v1beta",
        destination: "/api/v1beta",
      },
      {
        source: "/v1/:path*",
        destination: "/api/v1/:path*",
      },
      {
        source: "/v1",
        destination: "/api/v1",
      },
    ];
  },
};

export default nextConfig;
