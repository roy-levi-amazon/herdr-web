#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor/herdr"

required=(
  "$VENDOR/Cargo.toml"
  "$VENDOR/Cargo.lock"
  "$VENDOR/src/main.rs"
  "$VENDOR/src/api"
  "$VENDOR/src/api/client.rs"
  "$VENDOR/src/api/status.rs"
  "$VENDOR/src/api/schema.rs"
  "$VENDOR/src/api/schema"
  "$VENDOR/src/ipc.rs"
  "$VENDOR/src/logging.rs"
  "$VENDOR/src/protocol/wire.rs"
  "$VENDOR/src/server"
  "$VENDOR/src/server/socket_paths.rs"
  "$VENDOR/vendor/libghostty-vt.vendor.json"
)

for path in "${required[@]}"; do
  if [[ ! -e "$path" ]]; then
    echo "missing vendored Herdr file: $path" >&2
    exit 1
  fi
done

compare_exact() {
  local vendor_rel="$1"
  local bridge_rel="$2"
  if ! diff -q "$VENDOR/$vendor_rel" "$ROOT/$bridge_rel" >/dev/null; then
    echo "bridge compatibility copy drifted from vendored Herdr reference: $bridge_rel" >&2
    diff -u "$VENDOR/$vendor_rel" "$ROOT/$bridge_rel" | sed -n '1,120p' >&2
    exit 1
  fi
}

compare_wire_body() {
  if ! diff -q \
    <(awk 'seen || /^use std::collections::HashMap;/{seen=1} seen {print}' "$VENDOR/src/protocol/wire.rs") \
    <(awk 'seen || /^use std::collections::HashMap;/{seen=1} seen {print}' "$ROOT/bridge/src/protocol/wire.rs") \
    >/dev/null; then
    echo "bridge protocol wire copy drifted from vendored Herdr reference" >&2
    diff -u \
      <(awk 'seen || /^use std::collections::HashMap;/{seen=1} seen {print}' "$VENDOR/src/protocol/wire.rs") \
      <(awk 'seen || /^use std::collections::HashMap;/{seen=1} seen {print}' "$ROOT/bridge/src/protocol/wire.rs") \
      | sed -n '1,120p' >&2
    exit 1
  fi
}

compare_exact "src/api/schema.rs" "bridge/src/api/schema.rs"
while IFS= read -r -d '' vendor_schema_file; do
  file_name="$(basename "$vendor_schema_file")"
  if [[ "$file_name" == "tests.rs" ]]; then
    continue
  fi
  compare_exact "src/api/schema/$file_name" "bridge/src/api/schema/$file_name"
done < <(find "$VENDOR/src/api/schema" -maxdepth 1 -type f -name '*.rs' -print0)
compare_wire_body

if [[ -d "$VENDOR/target" ]]; then
  echo "warning: vendor/herdr/target is generated and should not be committed or archived" >&2
fi

if [[ -d "$VENDOR/vendor/libghostty-vt/.zig-cache" || -d "$VENDOR/vendor/libghostty-vt/zig-out" ]]; then
  echo "warning: vendored libghostty-vt build output should not be committed or archived" >&2
fi

echo "vendored Herdr layout looks clean"
