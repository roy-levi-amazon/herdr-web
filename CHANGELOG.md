# Changelog

## [Unreleased]

### Breaking Changes

### Added

- Added a bridge capabilities endpoint so the web app can discover supported commands without
  sending probe commands to Herdr.
- Added release-process documentation and a private-app release script.
- Added top-level agent onboarding guidance for web app, bridge overlay, vendoring, testing, and release work.

### Changed

- Added a bridge `Host` header allow-list and basic static security headers.
- Narrowed web bridge validation for workspace and tab creation parameters.
- Narrowed web bridge command validation for browser-launched pane input, splits, and agent starts.
- Added same-origin browser request checks to bridge API and WebSocket routes.
- Included Rust formatting checks for the vendored bridge overlay in the root lint command.

### Fixed

- Allowed the embedded Ghostty WASM loader under the bridge CSP so the terminal renderer can mount.
- Reworded terminal attach conflict copy and reports when uploads skip files beyond the batch limit.
- Rechecked sanitized upload filenames after truncation.
- Pointed the bridge launcher at the stable Herdr socket by default so the debug bridge does not
  fall back to `herdr-dev`.
- Fixed sidebar active workspace selection so explicit space picks are not overridden by a previously selected pane.
- Made terminal upload controls keyboard-operable and guarded upload status against overlapping uploads.
- Avoided duplicate default agent names when launching repeated agent splits.

### Removed
