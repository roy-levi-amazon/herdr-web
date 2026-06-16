# Vendoring Herdr

`herdr-web` vendors Herdr because the bridge depends on private API and wire protocol details that
are not exposed as a stable library or daemon API.

## What Is Vendored

`vendor/herdr/` is a full Herdr source snapshot kept as the upstream protocol/API reference.
The shipped bridge executable is the repo-owned `bridge/` crate:

- `bridge/src/main.rs` exposes the `herdr-web-bridge` command.
- `bridge/src/` contains bridge-owned compatibility code for session paths, config paths, API
  client/status types, socket path discovery, local socket connection, logging, and terminal wire
  protocol.
- `bridge/src/web_bridge.rs` is the repo-owned HTTP/WebSocket bridge implementation.
- `bridge/src/api/schema.rs` and `bridge/src/api/schema/` are copied from the vendored Herdr
  snapshot so serde request/response shapes stay explicit in this repo.
- `bridge/` does not path-import vendored Rust files at build time and does not build through
  `vendor/herdr/Cargo.toml` or its `build.rs`.

The browser app is not vendored into Herdr. It lives at `web/`, and `herdr-web-bridge` serves
`web/dist` through `--static-dir`.

## Current Snapshot

- Upstream checkout: `/home/kevin/worktrees/herdr`
- Upstream commit: `41d1c14e0784cf63dc4cddda21c7e5fd99813b24`
- Upstream release: `v0.7.0`

## Why Keep The Full Snapshot?

The bridge mirrors private pieces across Herdr:

- `crate::api::client::ApiClient`
- API schema enums and response types
- `crate::protocol::{ClientMessage, ServerMessage, RenderEncoding, ...}`
- local IPC socket helpers
- protocol version constants
- terminal attach launch mode and scroll frames

The implementation now uses a two-step approach:

1. Keep the full vendored Herdr snapshot so upstream refreshes and compatibility audits have a
   concrete source of truth.
2. Build and ship only the slim `herdr-web-bridge` crate, keeping copied bridge-owned
   compatibility code as narrow as practical.

Copying only the bridge-needed modules creates drift risk, so compatibility tests and vendoring
notes must stay tied to the upstream snapshot. Building directly through `vendor/herdr/Cargo.toml`
is intentionally avoided because Herdr's package build invokes the full terminal runtime build path.
`scripts/check-vendor.sh` fails if exact mirrored API schema files or the terminal wire protocol
body drift from the vendored reference snapshot without an intentional reconciliation.

## Refresh Process

Use a clean Herdr checkout as the base. Do not refresh from an experimental tree that may contain
unrelated local drift.

```bash
HERDR_SRC=/home/kevin/worktrees/herdr
HERDR_WEB=/home/kevin/worktrees/herdr-web
```

1. Verify the source checkout is clean:

```bash
git -C "$HERDR_SRC" status --short
git -C "$HERDR_SRC" rev-parse --short HEAD
```

2. Replace the vendored tree, excluding generated files:

```bash
rm -rf "$HERDR_WEB/vendor/herdr"
rsync -a \
  --exclude '/.git/' \
  --exclude '/target/' \
  --exclude '/mobile-web/' \
  --exclude '/vendor/libghostty-vt/.zig-cache/' \
  --exclude '/vendor/libghostty-vt/zig-out/' \
  "$HERDR_SRC/" "$HERDR_WEB/vendor/herdr/"
```

3. Reconcile bridge compatibility files:

```bash
# Compare these vendored reference areas with bridge-owned compatibility files and reconcile
# intentional changes into bridge/ as needed:
# - vendor/herdr/src/api/client.rs -> bridge/src/api/client.rs
# - vendor/herdr/src/api/status.rs -> bridge/src/api/status.rs
# - vendor/herdr/src/api/schema.rs -> bridge/src/api/schema.rs
# - vendor/herdr/src/api/schema/ -> bridge/src/api/schema/
# - vendor/herdr/src/protocol/wire.rs -> bridge/src/protocol/wire.rs
# - vendor/herdr/src/ipc.rs -> bridge/src/ipc.rs
# - vendor/herdr/src/logging.rs -> bridge/src/logging.rs
# - vendor/herdr/src/server/socket_paths.rs -> bridge/src/server/socket_paths.rs
```

4. Re-run validation:

```bash
scripts/check-vendor.sh
npm run lint
npm run test
npm run build
```

5. Smoke test:

```bash
scripts/run-bridge.sh
```

Open `http://127.0.0.1:8787`, attach multiple browser clients, switch panes, type, scroll, and use
the refit button after changing browser sizes.

## Compatibility Policy

The bridge pings Herdr's status API at startup and checks the reported daemon protocol against the
same supported range used for terminal attach. That catches incompatible daemon versions before
serving the web app, but it is not a complete stability guarantee because the bridge mirrors private
APIs.

When updating Herdr:

- inspect `src/protocol/wire.rs`
- inspect API schema changes under `src/api/schema/`
- inspect terminal attach handling in `src/server/headless.rs`
- rerun bridge tests and a browser smoke test
- update this document if the bridge compatibility surface changes

## Long-Term Removal Condition

Remove this vendored tree when Herdr exposes enough public surface for the bridge to live outside
Herdr:

- public snapshot/events API
- public terminal websocket or stable terminal attach protocol crate
- multi-client terminal fanout or documented attach ownership
- exact pane focus/selection endpoint
- resize ownership model
- browser authentication story
