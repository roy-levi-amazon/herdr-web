# Release Process

`herdr-web` is a private, vendored web app release. Releases create Git tags and GitHub releases;
they do not publish either npm package.

## Prerequisites

- Clean `main` branch.
- Node.js 22 or newer.
- Rust stable.
- Zig on `PATH` or exported through `ZIG`, because vendored Herdr builds `libghostty-vt`.
- GitHub CLI authenticated as a user that can create releases.
- A local Herdr session for browser smoke testing.

## Prepare

1. Confirm the changelog has user-facing notes under `## [Unreleased]`.
2. Confirm vendored Herdr is intentional and clean:

```bash
scripts/check-vendor.sh
```

3. Run the full automated check:

```bash
npm run check
```

If Zig is missing, install Zig or set `ZIG=/path/to/zig` before releasing. Do not cut a release
without bridge test/build coverage.

## Browser Smoke

Start or attach a Herdr session:

```bash
herdr
```

Build and run the web bridge:

```bash
npm run build
scripts/run-bridge.sh
```

Open `http://127.0.0.1:8787` and verify:

- The app loads the workspace, tab, pane, and split layout snapshot.
- Multiple browser clients can attach to the same terminal.
- Pane selection syncs between browser clients.
- Typing, mobile command input, scrolling, and refit work.
- New tabs can launch Shell, Codex, Claude, and pi.
- Split right/down can launch Shell, Codex, Claude, and pi.
- Upload button, paste upload, and drop upload place shell-quoted file paths in the terminal.
- Binding to `HOST=0.0.0.0` is only used on a trusted network.

## Cut

Run one of:

```bash
npm run release -- patch
npm run release -- minor
npm run release -- major
npm run release -- 0.1.0
```

The script:

- requires a clean `main` branch
- bumps `package.json`, `web/package.json`, and `web/package-lock.json`
- promotes `CHANGELOG.md` from `Unreleased` to the release version/date
- runs `npm run check`
- commits `Release vX.Y.Z`
- tags `vX.Y.Z`
- pushes `main` and the tag
- creates a GitHub release with generated notes
- opens the next `## [Unreleased]` changelog section and pushes it

## After

- Confirm the GitHub release exists and points at the expected tag.
- Confirm `CHANGELOG.md` on `main` has a fresh empty `## [Unreleased]` section.
- Keep release artifacts out of the repo unless a later packaging process explicitly adds them.
