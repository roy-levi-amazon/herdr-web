# Changelog

## [Unreleased]

### Breaking Changes

### Added

- Added a Capacitor Android shell that bundles the web app, stores bridge profiles with native
  Preferences, starts disconnected until a bridge is selected, and supports debug APK builds.
- Added bridge `--allow-origin` and `--allow-host` options with CORS preflight support for bundled
  Android bridge access and explicit hostname backends.
- Added Android build, sync, HTTP/cleartext, and smoke-test documentation.
- Added named bridge backend profiles and a settings dialog for switching the active backend.
- Added a bridge capabilities endpoint so the web app can discover supported commands without
  sending probe commands to Herdr.
- Added pane context-menu actions to move a pane into a new tab or a new workspace when the bridge
  exposes `pane.move`.
- Added styled Codex/OpenAI, Claude, and Pi icons in the agent list.
- Added a clear-name action for workspace and tab rename dialogs so custom names can return to
  their default labels.
- Added release-process documentation and a GitHub Release script.
- Added top-level agent onboarding guidance for web app, bridge overlay, vendoring, testing, and release work.

### Changed

- Added a bridge `Host` header allow-list and basic static security headers.
- Narrowed web bridge validation for workspace and tab creation parameters.
- Narrowed web bridge command validation for browser-launched pane input, splits, and agent starts.
- Added same-origin browser request checks to bridge API and WebSocket routes.
- Changed the Android shell origin to `http://localhost` with cleartext enabled for trusted-LAN
  HTTP bridge URLs.
- Disabled Android cloud backup for the shell and removed unused Capacitor mixed-content/deprecated
  runtime config.
- Included Rust formatting checks for the vendored bridge overlay in the root lint command.
- Changed mobile terminal taps to focus the command input by default, with raw terminal focus behind
  a keyboard-row button.
- Moved mobile arrow keys into the expanded keyboard and added separate `1`, `2`, and `3` quick keys.
- Changed new-tab launches so the entered title names the created pane while default-looking single-pane tabs display that pane title.
- Added bridge-provided clear-name state to snapshots so the web UI does not guess whether a workspace
  or tab name is already default.

### Fixed

- Sent desktop `Shift+Tab` through the web terminal as backtab instead of letting it fall through
  to browser focus traversal or plain Tab handling.
- Allowed the embedded Ghostty WASM loader under the bridge CSP so the terminal renderer can mount.
- Reworded terminal attach conflict copy and reports when uploads skip files beyond the batch limit.
- Rechecked sanitized upload filenames after truncation.
- Pointed the bridge launcher at the stable Herdr socket by default so the debug bridge does not
  fall back to `herdr-dev`.
- Fixed sidebar active workspace selection so explicit space picks are not overridden by a previously selected pane.
- Made terminal upload controls keyboard-operable and guarded upload status against overlapping uploads.
- Avoided duplicate default agent names when launching repeated agent splits.
- Kept clear-name requests compatible with older running Herdr daemons by translating them in the bridge.
- Hid the clear-name action when a workspace or tab is already using its default label.
- Preserved custom CORS preflight request headers for future bridge auth headers.
- Re-probed and reconnected active Android bridge sessions promptly after app foreground/resume.

### Removed
