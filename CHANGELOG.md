# Changelog

## [Unreleased]

### Breaking Changes

### Added

- Added a bridge-owned agent activity stream so pane status, title, display agent, and custom
  status updates reach connected browsers without waiting for a full snapshot refresh; concepts
  derived from the @roy-levi-amazon fork. [PR #11](https://github.com/kcosr/herdr-web/pull/11)
- Added Display settings for top/bottom app padding and mobile terminal controls size.
  [PR #13](https://github.com/kcosr/herdr-web/pull/13)
- Added configurable terminal input transport, with binary payload concepts derived from the
  @roy-levi-amazon fork. [PR #12](https://github.com/kcosr/herdr-web/pull/12)
- Added opt-in terminal input batching controls with a fixed 32-byte flush threshold for slow
  connections. [PR #12](https://github.com/kcosr/herdr-web/pull/12)
- Added a Shift-Tab key to the expanded mobile terminal key panel. [PR #11](https://github.com/kcosr/herdr-web/pull/11)

### Changed

- Reworked Settings into Bridge, Terminal, and Mobile areas, with horizontal area tabs on narrow
  screens. [PR #12](https://github.com/kcosr/herdr-web/pull/12)
- Improved browser startup by lazy-loading the terminal renderer with retry after load failures,
  adding installable mobile web app metadata and raster icons, and compressing static
  bridge-served web assets; concepts derived from the @roy-levi-amazon fork.
  [PR #10](https://github.com/kcosr/herdr-web/pull/10)

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
