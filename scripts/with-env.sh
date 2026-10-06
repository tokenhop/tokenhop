#!/bin/sh
# Run a command with secrets from an env file (default: .env.local, override with ENV_FILE).
# - File has op:// references -> resolved by 1Password `op run` (optional, maintainer setup).
# - Plain KEY=value file      -> exported directly; no 1Password needed.
# - No file                   -> command runs with the current environment.
# ponytail: plain files are sourced by sh, so values with spaces/specials must be quoted;
# swap to a dotenv parser if that bites.
set -e
f="${ENV_FILE:-.env.local}"
if [ -f "$f" ] && grep -q 'op://' "$f"; then
  command -v op >/dev/null 2>&1 || {
    echo "with-env: $f contains op:// references but the 1Password CLI (op) is not installed." >&2
    echo "Install op, or replace the references with plain values." >&2
    exit 1
  }
  exec op run --env-file="$f" -- "$@"
fi
if [ -f "$f" ]; then
  set -a
  case "$f" in /*) . "$f" ;; *) . "./$f" ;; esac
  set +a
fi
exec "$@"
