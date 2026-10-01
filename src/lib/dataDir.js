// The resolver is shared with the MITM server and the CLI (src/shared/dataDir).
import dataDir from "../shared/dataDir/index.cjs";

export const { getDataDir } = dataDir;

export const DATA_DIR = getDataDir();
