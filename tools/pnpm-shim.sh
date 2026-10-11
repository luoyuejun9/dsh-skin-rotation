#!/bin/sh
# Machine-local convenience: `dsh plugin` shells out to `pnpm`, which is not on
# this machine's PATH. Point PNPM_SHIM_NODE at a Node binary and
# PNPM_SHIM_CJS at pnpm's entry script, or keep the defaults below for a
# standard DeepSeek Harness desktop install. Gitignored; not part of the
# published package.
#
# Usage:  cp tools/pnpm-shim.sh /tmp/pnpm && chmod +x /tmp/pnpm && PATH=/tmp:$PATH dsh plugin ...
set -eu
NODE_BIN="${PNPM_SHIM_NODE:-$(command -v node || true)}"
PNPM_CJS="${PNPM_SHIM_CJS:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/pnpm/bin/pnpm.cjs}"
if [ -z "$NODE_BIN" ]; then
  echo "pnpm-shim: no node found; set PNPM_SHIM_NODE" >&2
  exit 127
fi
[ -f "$PNPM_CJS" ] || { echo "pnpm-shim: pnpm entry not found at $PNPM_CJS; set PNPM_SHIM_CJS" >&2; exit 127; }
exec "$NODE_BIN" "$PNPM_CJS" "$@"
