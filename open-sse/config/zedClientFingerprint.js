// Zed client fingerprint — the identity tokenhop presents to zed.dev /
// cloud.zed.dev on `zed` provider traffic.
//
// Mirrors upstream Zed: every HTTP request carries
//   User-Agent: Zed/<version> (<os>; <arch>)        (crates/zed/src/main.rs)
// and LLM completions add `x-zed-version: <version>`
// (crates/language_models_cloud). Zed Cloud gates clients by version
// (`x-zed-minimum-required-version`), so a missing or stale version can yield
// an empty model catalog or rejected completions.
//
// ZED_CLIENT_VERSION overrides the reported version; a malformed value throws
// at module load. Bump the default alongside Zed stable releases.

import { envString } from "./envOverride.js";

const SEMVER = /^\d+\.\d+\.\d+$/;

// Node → Rust `std::env::consts::{OS, ARCH}` spellings, as Zed reports them.
const RUST_OS = { darwin: "macos", win32: "windows", linux: "linux", freebsd: "freebsd" };
const RUST_ARCH = { x64: "x86_64", arm64: "aarch64", ia32: "x86", arm: "arm" };

export function zedUserAgent(version, platform = process.platform, arch = process.arch) {
  return `Zed/${version} (${RUST_OS[platform] || platform}; ${RUST_ARCH[arch] || arch})`;
}

export const ZED_CLIENT_VERSION = envString("ZED_CLIENT_VERSION", "1.20.2", SEMVER);
export const ZED_CLIENT_USER_AGENT = zedUserAgent(ZED_CLIENT_VERSION);
