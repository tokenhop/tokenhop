const path = require("path");
const { getDataDir } = require("../shared/dataDir/index.cjs");

const DATA_DIR = getDataDir();
const MITM_DIR = path.join(DATA_DIR, "mitm");

module.exports = { DATA_DIR, MITM_DIR };
