#!/usr/bin/env bash
#
# install.sh — install cc-proxy from a clone of the repo.
#
# Default flow:  npm ci  →  npm test  →  npm run build  →  npm link
# Flags:
#   --skip-test      Skip both `npm ci` and `npm test` (deps already
#                    present and a build is all that's needed); still
#                    builds + links.
#   -h, --help       Show this message and exit
#
# Any other flag is an error. The script never ruins an in-flight working
# state: each step bails on failure so you keep the last good build.

set -euo pipefail

SKIP_TEST=0

usage() {
  sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-test) SKIP_TEST=1 ;;
    -h|--help)   usage 0 ;;
    *)           echo "install.sh: unknown flag: $1" >&2; usage 1 ;;
  esac
  shift
done

# Resolve the repo root (the directory this script lives in) regardless of cwd.
# We can't rely on BASH_SOURCE in every shell, so fall back to $0.
script_dir="$(cd "$(dirname "${BASH_SOURCE:-$0}")" && pwd)"
cd "$script_dir"

# Node 18+ guard — mirrors bin/cc-proxy.js so the error message is familiar.
major_node="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major_node" -lt 18 ]; then
  echo "cc-proxy requires Node.js 18 or newer (found $(node -v))." >&2
  echo "Please upgrade Node: https://nodejs.org/" >&2
  exit 1
fi

echo "==> cc-proxy install (skip-test=$SKIP_TEST)"

if [ "$SKIP_TEST" -eq 0 ]; then
  echo "==> npm ci"
  npm ci
  echo "==> npm test"
  npm test
else
  echo "==> (skipping npm ci + npm test)"
fi

echo "==> npm run build"
npm run build

echo "==> npm link"
npm link

echo "==> done. cc-proxy is now available as 'cc-proxy' on your PATH."
