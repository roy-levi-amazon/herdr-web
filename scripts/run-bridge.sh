#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8787}"
BRIDGE_BIN="${BRIDGE_BIN:-$ROOT/bridge/target/debug/herdr-web-bridge}"
STATIC_DIR="${STATIC_DIR:-$ROOT/web/dist}"
UPLOAD_DIR="${UPLOAD_DIR:-}"

if [[ -z "${HERDR_SOCKET_PATH:-}" ]]; then
  if [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
    export HERDR_SOCKET_PATH="$XDG_CONFIG_HOME/herdr/herdr.sock"
  elif [[ -n "${HOME:-}" ]]; then
    export HERDR_SOCKET_PATH="$HOME/.config/herdr/herdr.sock"
  fi
fi

if [[ ! -x "$BRIDGE_BIN" ]]; then
  echo "bridge binary not found at $BRIDGE_BIN" >&2
  echo "run: npm run bridge:build" >&2
  exit 1
fi

if [[ -n "${HERDR_SOCKET_PATH:-}" && ! -S "$HERDR_SOCKET_PATH" ]]; then
  echo "warning: Herdr socket not found at HERDR_SOCKET_PATH=$HERDR_SOCKET_PATH" >&2
  echo "start Herdr first, or set HERDR_SOCKET_PATH to the running session socket" >&2
fi

args=(--host "$HOST" --port "$PORT" --static-dir "$STATIC_DIR")
if [[ -n "$UPLOAD_DIR" ]]; then
  args+=(--upload-dir "$UPLOAD_DIR")
fi
args+=("$@")

exec "$BRIDGE_BIN" "${args[@]}"
