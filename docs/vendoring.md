# Vendoring Herdr

`herdr-web` currently vendors Herdr because the bridge depends on private Rust modules and wire
protocol details that are not exposed as a stable library or daemon API.

## What Is Vendored

`vendor/herdr/` is a full Herdr source snapshot plus the web bridge overlay:

- `src/web_bridge.rs`
- `src/main.rs` command wiring for `herdr web-bridge`
- bridge dependencies in `Cargo.toml`
- matching `Cargo.lock`

The browser app is not vendored into Herdr. It lives at `web/`, and the bridge serves `web/dist`
through `--static-dir`.

## Current Snapshot

- Upstream checkout: `/home/kevin/worktrees/herdr`
- Upstream commit: `41d1c14e0784cf63dc4cddda21c7e5fd99813b24`
- Upstream release: `v0.7.0`

## Why Not Copy Only A Few Files?

The bridge needs private pieces across Herdr:

- `crate::api::client::ApiClient`
- API schema enums and response types
- `crate::protocol::{ClientMessage, ServerMessage, RenderEncoding, ...}`
- local IPC socket helpers
- protocol version constants
- terminal attach launch mode and scroll frames

Copying only those modules would create a partial fork with hidden dependencies. Vendoring the full
tree is heavier, but it keeps the bridge buildable and makes compatibility failures obvious.

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

3. Reapply the web bridge overlay:

```bash
# Either apply a maintained patch series, or copy/update these files from the bridge worktree.
# Required overlay files today:
# - vendor/herdr/src/web_bridge.rs
# - vendor/herdr/src/main.rs
# - vendor/herdr/Cargo.toml
# - vendor/herdr/Cargo.lock
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

The bridge checks Herdr's terminal attach protocol version before opening an attach. That catches
some incompatible daemon versions, but it is not a complete stability guarantee because the bridge
uses private APIs.

When updating Herdr:

- inspect `src/protocol/wire.rs`
- inspect API schema changes under `src/api/schema/`
- inspect terminal attach handling in `src/server/headless.rs`
- rerun bridge tests and a browser smoke test
- update this document if the bridge overlay shape changes

## Long-Term Removal Condition

Remove this vendored tree when Herdr exposes enough public surface for the bridge to live outside
Herdr:

- public snapshot/events API
- public terminal websocket or stable terminal attach protocol crate
- multi-client terminal fanout or documented attach ownership
- exact pane focus/selection endpoint
- resize ownership model
- browser authentication story
