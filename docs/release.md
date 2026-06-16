# Release Process

`herdr-web` is a private, vendored web app release. Releases create Git tags and GitHub releases.
They do not publish npm packages, and the package versions are not release versions.

## Prerequisites

- Clean `main` branch.
- Node.js 22 or newer.
- Rust stable.
- Zig on `PATH` or exported through `ZIG`, because vendored Herdr builds `libghostty-vt`.
- JDK 21 and Android SDK when validating the Android shell.
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

Choose the GitHub release version explicitly and run:

```bash
node scripts/release.mjs v0.1.0
```

The script:

- requires a clean `main` branch
- promotes `CHANGELOG.md` from `Unreleased` to the release version/date
- runs `npm run check`
- commits `Release vX.Y.Z`
- tags `vX.Y.Z`
- pushes `main` and the tag atomically
- creates a GitHub release with notes extracted from `CHANGELOG.md`
- opens the next `## [Unreleased]` changelog section and pushes it

Release artifact upload is intentionally not part of the process yet. Add that checklist later once
the build and packaging output is settled.

## Android Validation

The Android shell is not part of release artifact upload yet. Before distributing Android builds,
follow [docs/android.md](android.md): run `npm run android:sync`, build a debug APK with
`npm run android:build:debug`, and smoke test bridge configuration on a device or emulator with a
bridge started using `--allow-origin http://localhost`. Revisit the Android backup policy before
adding any pairing token or other secret storage.

## After

- Confirm the GitHub release exists and points at the expected tag.
- Confirm `CHANGELOG.md` on `main` has a fresh empty `## [Unreleased]` section.
- Do not upload artifacts until the release build/packaging process is defined.
