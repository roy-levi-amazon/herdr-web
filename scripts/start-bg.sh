#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="/tmp/herdr-web"
mkdir -p "$LOG_DIR"

# Kill any existing instances
"$ROOT/scripts/stop-bg.sh" 2>/dev/null || true
sleep 0.5

# Start bridge
nohup "$ROOT/scripts/run-bridge.sh" --allow-origin "https://${USER}-herdr.c.tunnels.lab.aws.dev" \
  > "$LOG_DIR/bridge.log" 2>&1 &
BRIDGE_PID=$!

# Start tunnel
nohup tunnel create 8787 --name herdr \
  > "$LOG_DIR/tunnel.log" 2>&1 &
TUNNEL_PID=$!

disown $BRIDGE_PID $TUNNEL_PID

echo "Started:"
echo "  bridge  pid=$BRIDGE_PID  log=$LOG_DIR/bridge.log"
echo "  tunnel  pid=$TUNNEL_PID  log=$LOG_DIR/tunnel.log"
echo ""
echo "Stop with: pkill -f herdr-web-bridge; pkill -f 'tunnel create 8787'"
