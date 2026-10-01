const fs = require("fs");
const path = require("path");

// The CLI build packs the shared modules into cli/src/shared/; a repo checkout uses the source.
function requireShared(name) {
  const packed = path.join(__dirname, "..", "..", "shared", name, "index.cjs");
  return require(
    fs.existsSync(packed)
      ? packed
      : path.join(__dirname, "..", "..", "..", "..", "src", "shared", name, "index.cjs"),
  );
}

module.exports = { requireShared };
