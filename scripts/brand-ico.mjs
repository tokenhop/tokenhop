#!/usr/bin/env node
// Assembles Windows .ico files from PNG rasters (PNG-in-ICO, Vista+).
//
// ponytail: `sharp` is only a transitive optional dep of next here, so this
// repo does not rasterize. Generate the source PNGs once with the brand
// resources repo (github.com/tokenhop/resources, source/rasterize.mjs), commit
// the rasters, and use this script to wrap them into .ico files.
//
// Usage:
//   node scripts/brand-ico.mjs --out cli/src/cli/tray/icon-tokenhop.ico \
//     --png png/mark-16.png png/mark-32.png png/mark-48.png
//
// Node stdlib only; no dependencies.

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { png: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      i += 1;
      args.out = argv[i];
    } else if (arg === "--png") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        i += 1;
        args.png.push(argv[i]);
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.out || args.png.length === 0) {
    throw new Error("Usage: brand-ico.mjs --out <file.ico> --png <a.png> [b.png ...]");
  }
  return args;
}

// ICO directory entry dimension byte: 0 encodes 256; PNG side lengths only.
function dimensionByte(size) {
  if (size <= 0 || size > 256 || !Number.isInteger(size)) {
    throw new Error(`Unsupported icon size: ${size}`);
  }
  return size === 256 ? 0 : size;
}

function pngDimensions(buffer) {
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error("Not a PNG file");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function buildIco(pngBuffers) {
  const images = pngBuffers.map((buffer) => {
    const { width, height } = pngDimensions(buffer);
    if (width !== height) throw new Error("ICO entries must be square");
    return { buffer, size: width };
  });
  images.sort((a, b) => a.size - b.size);

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, i) => {
    const entry = i * 16;
    directory.writeUInt8(dimensionByte(image.size), entry); // width
    directory.writeUInt8(dimensionByte(image.size), entry + 1); // height
    directory.writeUInt8(0, entry + 2); // palette
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // color planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(image.buffer.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.buffer.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.buffer)]);
}

const args = parseArgs(process.argv);
const pngBuffers = args.png.map((file) => fs.readFileSync(path.resolve(file)));
fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
fs.writeFileSync(args.out, buildIco(pngBuffers));
console.log(`${args.out}: ${args.png.join(", ")}`);
