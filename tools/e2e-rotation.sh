#!/usr/bin/env bash
#
# End-to-end rotation check.
#
# Boots a real DeepSeek Harness host against an isolated DSH_HOME, then asserts
# what the plugin claims against what the browser is actually served: the route
# state, the pick written into both patch layers, and the skin modules present
# in the page's boot graph. Run it twice (or more) to see the pick change.
#
# Usage:
#   tools/e2e-rotation.sh <dsh-home> <profile> [port]
#
# Example:
#   tools/e2e-rotation.sh /tmp/dsh-rotation-test rot 19487
#   tools/e2e-rotation.sh /tmp/dsh-rotation-test rot 19487
#
# Requirements: a `dsh` binary on PATH (or $DSH_BIN), curl, node, and a profile
# in <dsh-home>/profiles/<profile> that lists this bundle plus at least two
# installed skins.
set -u

DSH_HOME_DIR="${1:?usage: e2e-rotation.sh <dsh-home> <profile> [port]}"
PROFILE="${2:?usage: e2e-rotation.sh <dsh-home> <profile> [port]}"
PORT="${3:-19487}"
DSH_BIN="${DSH_BIN:-dsh}"
LOG="$(mktemp -t dsh-rotation-e2e)"
COOKIES="$(mktemp -t dsh-rotation-cookies)"
PAGE="$(mktemp -t dsh-rotation-page)"
STATE="$(mktemp -t dsh-rotation-state)"

export DSH_HOME="$DSH_HOME_DIR"

cleanup() {
  if [ -n "${PID:-}" ]; then
    kill "$PID" 2>/dev/null
    sleep 2
    kill -9 "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
  fi
  rm -f "$LOG" "$COOKIES" "$PAGE" "$STATE"
}
trap cleanup EXIT

echo "booting: dsh --profile $PROFILE --port $PORT (DSH_HOME=$DSH_HOME)"
"$DSH_BIN" --profile "$PROFILE" --port "$PORT" --no-open >"$LOG" 2>&1 &
PID=$!

TOKEN=""
for _ in $(seq 1 90); do
  TOKEN=$(sed -n 's/.*token=\([A-Za-z0-9_-]*\).*/\1/p' "$LOG" | head -1)
  [ -n "$TOKEN" ] && break
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
if [ -z "$TOKEN" ]; then
  echo "BOOT FAILED — host never printed a token:" >&2
  cat "$LOG" >&2
  exit 1
fi

sleep 6

echo
echo "--- route state ---"
curl -s "http://127.0.0.1:$PORT/api/dsh/skin-rotation" -o "$STATE"
node -e '
const s = require(process.argv[1]);
console.log(JSON.stringify({
  enabled: s.enabled,
  current: s.current,
  pickedThisBoot: s.pickedThisBoot,
  poolSize: s.poolSize,
  client: s.lastClientReport,
}, null, 1));
' "$STATE" || cat "$STATE"

echo
echo "--- skin modules the browser is actually served ---"
curl -sL -c "$COOKIES" -b "$COOKIES" -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:$PORT/?token=$TOKEN" -o "$PAGE"
grep -o 'client-ui-skin-[a-z0-9-]*' "$PAGE" | sort -u

echo
echo "--- assertions ---"
node -e '
const fs = require("fs");
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const html = fs.readFileSync(process.argv[2], "utf8");
const picked = s.pickedThisBoot;
const skins = s.skins ?? [];
const pickedSkin = skins.find((skin) => skin.id === picked);
if (picked === null || pickedSkin === undefined) {
  console.error("FAIL: no skin was picked for this launch");
  process.exit(1);
}
if (s.current !== picked) {
  console.error(`FAIL: patch says ${s.current}, this launch picked ${picked}`);
  process.exit(1);
}
const served = skins.filter((skin) => html.includes(skin.package));
if (served.length !== 1 || served[0].id !== picked) {
  console.error(`FAIL: expected only ${picked} in the boot graph, got [${served.map((skin) => skin.id)}]`);
  process.exit(1);
}
if (!html.includes("dsh-skin-rotation")) {
  console.error("FAIL: the plugin client bundle is not in the boot graph");
  process.exit(1);
}
console.log(`PASS: picked ${picked}, only that skin is served, plugin bundle present`);
' "$STATE" "$PAGE"
