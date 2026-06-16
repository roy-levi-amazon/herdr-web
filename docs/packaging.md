# Packaging

`herdr-web` ships as separate desktop bridge/web tarballs and an Android APK.

The desktop tarball does not include Herdr itself. Users still need a running Herdr session or
daemon; the bundled bridge connects to the normal Herdr socket.

## Release Artifacts

Recommended GitHub release assets:

```text
herdr-web-vX.Y.Z-linux-x86_64.tar.gz
herdr-web-vX.Y.Z-linux-x86_64.tar.gz.sha256
herdr-web-vX.Y.Z-macos-arm64.tar.gz
herdr-web-vX.Y.Z-macos-arm64.tar.gz.sha256
herdr-web-vX.Y.Z-android.apk
```

Build Linux artifacts on Linux. Build macOS ARM artifacts on an Apple Silicon Mac. Build the APK
from any machine with the documented Android SDK setup.

## Desktop Tarball Shape

```text
herdr-web-vX.Y.Z-PLATFORM/
  bin/herdr-web
  bin/herdr-web-bridge
  share/herdr-web/web/
  README.md
  PACKAGING.md
```

`bin/herdr-web` is a small wrapper that runs `herdr-web-bridge` with `--static-dir` pointed at the
bundled web assets.

## Build A Desktop Tarball

Install dependencies first:

```bash
npm ci
npm ci --prefix web
```

Build the tarball:

```bash
scripts/package-tarball.sh vX.Y.Z linux-x86_64
```

On macOS ARM:

```bash
scripts/package-tarball.sh vX.Y.Z macos-arm64
```

The output is written under `dist-packages/`:

```text
dist-packages/herdr-web-vX.Y.Z-PLATFORM.tar.gz
dist-packages/herdr-web-vX.Y.Z-PLATFORM.tar.gz.sha256
```

## Build Android APK

Follow [docs/android.md](android.md) for SDK prerequisites, then build:

```bash
npm ci
npm ci --prefix web
npm run android:build:debug
```

The debug build artifact is:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

For a public release, replace this with a signed release APK before publishing.

## User Quick Start From Tarball

Start or attach Herdr first:

```bash
herdr
```

Unpack and run:

```bash
tar -xzf herdr-web-vX.Y.Z-linux-x86_64.tar.gz
cd herdr-web-vX.Y.Z-linux-x86_64
bin/herdr-web
```

Open:

```text
http://127.0.0.1:8787
```

For LAN or Android testing:

```bash
bin/herdr-web --host 0.0.0.0 --port 4000 --allow-origin http://localhost
```

If using a DNS hostname from Android, also allow it:

```bash
bin/herdr-web --host 0.0.0.0 --port 4000 \
  --allow-origin http://localhost \
  --allow-host herdr-host.local
```

Then install the Android APK and add the bridge URL in Bridges settings.

## Manual Release Upload

The release script creates the GitHub release from changelog notes. Tarballs and APKs are uploaded
manually after the release exists:

```bash
gh release upload vX.Y.Z \
  dist-packages/herdr-web-vX.Y.Z-linux-x86_64.tar.gz \
  dist-packages/herdr-web-vX.Y.Z-linux-x86_64.tar.gz.sha256 \
  dist-packages/herdr-web-vX.Y.Z-macos-arm64.tar.gz \
  dist-packages/herdr-web-vX.Y.Z-macos-arm64.tar.gz.sha256 \
  android/app/build/outputs/apk/debug/app-debug.apk
```

Rename the APK to the release asset name before uploading if publishing it as
`herdr-web-vX.Y.Z-android.apk`.
