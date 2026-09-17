#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
GAME_BIN="${STK_GAME_BIN:-$REPO_DIR/build/bin/supertuxkart.app/Contents/MacOS/supertuxkart}"
ASSET_ROOT="${STK_ASSET_ROOT:-/Applications/SuperTuxKart.app/Contents/Resources}"
STATE_PORT="${JEV_STATE_PORT:-19736}"
CONTROL_PORT="${JEV_CONTROL_PORT:-19737}"

if [[ ! -x "$GAME_BIN" ]]; then
  echo "Modified SuperTuxKart binary not found: $GAME_BIN" >&2
  echo "Build it first with: tools/jev-controller/build-macos.sh" >&2
  exit 1
fi
if [[ ! -d "$ASSET_ROOT/data/tracks" ]]; then
  echo "SuperTuxKart assets not found under: $ASSET_ROOT" >&2
  exit 1
fi
if [[ "${1:-}" != "--mock" && -z "${AI_GATEWAY_API_KEY:-}" \
  && ! -f "$SCRIPT_DIR/.env" && ! -f "$REPO_DIR/.env" ]]; then
  echo "AI_GATEWAY_API_KEY is required for the Jev demo." >&2
  echo "Export it or put it in .env or tools/jev-controller/.env." >&2
  echo "Use --mock only for a local protocol/physics test." >&2
  exit 1
fi

if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
  npm --prefix "$SCRIPT_DIR" ci
fi

node "$SCRIPT_DIR/bridge.mjs" "$@" &
BRIDGE_PID=$!
cleanup() {
  kill "$BRIDGE_PID" 2>/dev/null || true
  wait "$BRIDGE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sleep 0.2
if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
  wait "$BRIDGE_PID"
fi

SUPERTUXKART_DATADIR="$REPO_DIR" \
SUPERTUXKART_ASSETS_DIR="$ASSET_ROOT/data" \
"$GAME_BIN" \
  --race-now \
  --track="${STK_TRACK:-lighthouse}" \
  --kart="${STK_KART:-tux}" \
  --numkarts="${STK_NUM_KARTS:-4}" \
  --laps=1 \
  --difficulty="${STK_DIFFICULTY:-1}" \
  --no-high-scores \
  --jev-controller \
  --jev-state-port="$STATE_PORT" \
  --jev-control-port="$CONTROL_PORT" \
  --jev-telemetry-hz="${JEV_TELEMETRY_HZ:-10}" \
  --jev-timeout-ms="${JEV_TIMEOUT_MS:-2500}"
