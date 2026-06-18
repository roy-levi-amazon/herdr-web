# Changelog

## [Unreleased]

### Breaking Changes

### Added

- Added a bridge-owned agent activity stream so pane status, title, display agent, and custom
  status updates reach connected browsers without waiting for a full snapshot refresh.
- Added a Shift-Tab key to the expanded mobile terminal key panel.

### Changed

- Improved browser startup by lazy-loading the terminal renderer with retry after load failures,
  adding installable mobile web app metadata and raster icons, and compressing static
  bridge-served web assets.

### Fixed

### Removed

## [0.1.1] - 2026-06-17

### Breaking Changes

### Added

- Added a native Android setting, on by default, to blur text inputs and refit the terminal after
  the keyboard closes.
- Added an opt-in mobile terminal long-press selection setting with drag-to-copy selection, selected
  URL actions, and touch hit-testing for Ghostty-detected links.

### Changed

- Changed bridge URL validation so users can save HTTP bridge URLs at any valid host or IP address.

### Fixed

- Forced and reapplied Android dark system bar styling with light status/navigation bar icons.
- Removed duplicate bottom safe-area padding inside the mobile terminal controls.

### Removed

## [0.1.0] - 2026-06-16

### Added

- Initial release.
