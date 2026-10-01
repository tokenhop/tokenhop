import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const REAL_TESTS = "translator/real/**";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Don't scan into git worktrees nested under .claude/ — they carry their
    // own copies of the test files but lack an installed node_modules (open-sse,
    // etc.), which makes provider imports fail during collection.
    exclude: [
      "**/node_modules/**",
      "**/.claude/**",
      "**/.config/opencode/worktrees/**",
      "**/dist/**",
    ],
    // Every test file gets its own temp DATA_DIR + HOME under one parent temp
    // dir that is removed after the run (see setup/).
    globalSetup: [resolve(__dirname, "setup/tempRoot.js")],
    setupFiles: [resolve(__dirname, "setup/isolateDataDir.js")],
    // The HOME override only reaches os.homedir() in child processes.
    pool: "forks",
    // Allow many it.concurrent cases (real provider smoke runs ~50 providers in parallel)
    maxConcurrency: 60,
    // Suppress noisy console output from handlers under test
    silent: false,
    // `include` lives on each project: array options are concatenated with the
    // root config when a project `extends` it.
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["**/*.test.js"], exclude: [REAL_TESTS] },
      },
      {
        // Live-provider tests. Isolated too, unless RUN_REAL=1 / RUN_E2E=1 is set.
        extends: true,
        test: {
          name: "real",
          include: [`${REAL_TESTS}/*.test.js`],
          env: { TOKENHOP_TEST_REAL_PROJECT: "1" },
        },
      },
    ],
  },
  resolve: {
    // Use array form so subpath aliases (e.g. "@/lib/db/index.js") resolve correctly.
    alias: [
      { find: /^open-sse\//, replacement: resolve(__dirname, "../open-sse") + "/" },
      { find: "open-sse", replacement: resolve(__dirname, "../open-sse") },
      { find: /^@\//, replacement: resolve(__dirname, "../src") + "/" },
    ],
  },
});
