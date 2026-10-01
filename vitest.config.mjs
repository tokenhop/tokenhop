// The suite's config lives in tests/. Re-exported here so `npx vitest` run from
// the repo root still gets the setup that points HOME/DATA_DIR at a temp dir;
// without it, tests write to (and delete under) the developer's real home.
export { default } from "./tests/vitest.config.js";
