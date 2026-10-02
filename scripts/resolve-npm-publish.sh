#!/usr/bin/env bash
# resolve-npm-publish.sh — decide how .github/workflows/release-npm.yml publishes the CLI.
#
# The package name and version always come from the CLI's package.json; nothing
# here hardcodes either. Rules:
#
#   tag push (v*):   the tag must equal the CLI package.json version, otherwise
#                    the run fails — a v0.6.x patch tag (or any stale tag) can
#                    never publish from master.
#   dist-tag:        any prerelease version (a "-" in it, e.g. 1.0.0-beta.1)
#                    publishes with --tag beta and never moves latest; a stable
#                    version publishes as latest.
#   dry run:         workflow_dispatch defaults to a dry run; only a tag push,
#                    or an explicit dry_run=false dispatch from master, really
#                    publishes.
#
# The workflow calls this script and consumes its step outputs (version,
# dist_tag, dry_run) via $GITHUB_OUTPUT; without that variable the outputs go
# to stdout. `--self-test` exercises the same code path with fixtures and
# asserts every rule above; it never touches npm.

set -euo pipefail

SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'

fail() {
  echo "::error::$*" >&2
  exit 1
}

read_version() {
  node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$1"
}

# resolve <package.json> <event> <tag> <dry_run_input> <ref>
# Prints the step outputs as key=value lines on stdout.
resolve() {
  local package_json=$1 event=$2 tag=$3 dry_run_input=$4 ref=$5

  [[ -f $package_json ]] || fail "package.json not found: $package_json"
  local version
  version=$(read_version "$package_json")
  [[ $version =~ $SEMVER_RE ]] || fail "version '$version' in $package_json is not semver"

  local dist_tag=latest
  if [[ $version == *-* ]]; then
    dist_tag=beta
  fi

  local dry_run
  if [[ $event == push ]]; then
    [[ -n $tag ]] || fail "tag push without a tag name"
    local tag_version=${tag#v}
    [[ $tag_version == "$version" ]] ||
      fail "tag '$tag' does not equal $package_json version '$version' — refusing to publish"
    dry_run=false
  else
    dry_run=${dry_run_input:-true}
    if [[ $dry_run == false && $ref != refs/heads/master ]]; then
      fail "a real publish (dry_run=false) needs a v* tag or a master dispatch, not ref '$ref'"
    fi
  fi

  echo "Resolved npm publish: version=$version dist-tag=$dist_tag dry-run=$dry_run" >&2
  echo "version=$version"
  echo "dist_tag=$dist_tag"
  echo "dry_run=$dry_run"
}

emit() {
  local package_json=${PACKAGE_JSON:-cli/package.json}
  local event=${EVENT:-workflow_dispatch}
  local tag=${TAG:-}
  local dry_run_input=${DRY_RUN_INPUT:-true}
  local ref=${REF:-}

  local outputs
  outputs=$(resolve "$package_json" "$event" "$tag" "$dry_run_input" "$ref")
  if [[ -n ${GITHUB_OUTPUT:-} ]]; then
    echo "$outputs" >>"$GITHUB_OUTPUT"
  else
    echo "$outputs"
  fi
}

self_test() {
  local tmp failures=0
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN

  printf '{"name":"fixture","version":"1.0.0"}\n' >"$tmp/stable.json"
  printf '{"name":"fixture","version":"1.0.0-beta.1"}\n' >"$tmp/beta.json"
  printf '{"name":"fixture","version":"1.0"}\n' >"$tmp/bad.json"

  # check <name> <pkg> <event> <tag> <dry_run_input> <ref> <want_dist_tag|FAIL> [want_dry_run]
  check() {
    local name=$1 pkg=$2 event=$3 tag=$4 dry_in=$5 ref=$6 want_dist=$7 want_dry=${8:-}
    local out rc=0
    out=$(resolve "$pkg" "$event" "$tag" "$dry_in" "$ref" 2>/dev/null) || rc=$?
    if [[ $want_dist == FAIL ]]; then
      if ((rc == 0)); then
        echo "FAIL $name: expected an error, got: $out"
        failures=$((failures + 1))
      else
        echo "ok   $name"
      fi
      return
    fi
    local got_dist got_dry
    got_dist=$(echo "$out" | sed -n 's/^dist_tag=//p')
    got_dry=$(echo "$out" | sed -n 's/^dry_run=//p')
    if ((rc != 0)) || [[ $got_dist != "$want_dist" || $got_dry != "$want_dry" ]]; then
      echo "FAIL $name: want dist_tag=$want_dist dry_run=$want_dry, got rc=$rc dist_tag=$got_dist dry_run=$got_dry"
      failures=$((failures + 1))
    else
      echo "ok   $name"
    fi
  }

  check "stable tag publishes as latest" "$tmp/stable.json" push v1.0.0 "" refs/tags/v1.0.0 latest false
  check "prerelease tag publishes as beta" "$tmp/beta.json" push v1.0.0-beta.1 "" refs/tags/v1.0.0-beta.1 beta false
  check "tag newer than package fails" "$tmp/stable.json" push v1.0.1 "" refs/tags/v1.0.1 FAIL
  check "v0.6.x patch tag vs master version fails" "$tmp/stable.json" push v0.6.1 "" refs/tags/v0.6.1 FAIL
  check "dispatch defaults to dry run" "$tmp/stable.json" workflow_dispatch "" true refs/heads/master latest true
  check "master dispatch may really publish" "$tmp/stable.json" workflow_dispatch "" false refs/heads/master latest false
  check "topic-branch dispatch cannot really publish" "$tmp/stable.json" workflow_dispatch "" false refs/heads/topic FAIL
  check "non-semver version fails" "$tmp/bad.json" push v1.0 "" refs/tags/v1.0 FAIL
  check "prerelease dispatch dry run keeps beta" "$tmp/beta.json" workflow_dispatch "" true refs/heads/master beta true

  if ((failures > 0)); then
    echo "self-test: $failures case(s) failed" >&2
    return 1
  fi
  echo "self-test: all 9 cases passed"
}

case ${1:-} in
  --self-test)
    self_test
    ;;
  "" )
    emit
    ;;
  *)
    echo "usage: $0 [--self-test]" >&2
    echo "inputs are env vars: PACKAGE_JSON EVENT TAG DRY_RUN_INPUT REF (see file header)" >&2
    exit 2
    ;;
esac
