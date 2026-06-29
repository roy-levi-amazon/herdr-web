#!/usr/bin/env bash
set -euo pipefail

killed=0

if pkill -f 'herdr-web-bridge' 2>/dev/null; then
  echo "Stopped bridge"
  killed=$((killed + 1))
fi

if pkill -f 'tunnel create 8787' 2>/dev/null; then
  echo "Stopped tunnel"
  killed=$((killed + 1))
fi

if [[ $killed -eq 0 ]]; then
  echo "Nothing running"
fi
