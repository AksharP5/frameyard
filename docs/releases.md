# Linux releases

Tagged public releases provide portable Linux x64 archives. The release workflow checks
types, lint, and tests, then verifies the packaged app can open a project,
capture frames, and export H.264 MP4 under Ubuntu 24.04. Each release includes
`SHA256SUMS` for the archive. CI artifacts from branch and pull request builds
are available for 14 days; only tagged releases appear on the Releases page.
Until the first public release, [install from source](../README.md#install).

## Use a release

Download the Linux x64 `.tar.gz` and `SHA256SUMS` files from this repository's
GitHub release. In the download directory, verify and extract them:

```sh
sha256sum --check SHA256SUMS
tar -xzf frameyard-VERSION-linux-x64.tar.gz
cd Frameyard-linux-x64
./frameyard
./resources/cli/bin/dapi open ~/Videos/my-project
```

Replace `VERSION` with the downloaded version. Keep the extracted directory
intact. The CLI uses the included Electron runtime, so it does not need a separate
Node installation. The portable archive does not add application menu entries or
shell commands. For those, use the [source installer](../README.md#install).

The app requires a graphical Linux desktop and Electron's system libraries.
On Ubuntu 24.04, install `libasound2t64`, `libatk-bridge2.0-0`, `libgtk-3-0`,
`libgbm1`, and `libnss3`. FFmpeg is needed for local media operations.

Whisper, its model, Manim, HyperFrames, and Hyfrme are separate downloads, not
bundled in the archive. To use transcription or local animation rendering,
check out the matching source tag and run `npm ci` and `npm run setup:local`.
That setup needs Node 22.18 or newer, npm, uv, FFmpeg, Cairo, Pango, and
pkg-config. Mathematical typesetting in Manim also needs the optional TeX
packages listed in the [Linux guide](linux.md).

For release maintenance, see [Contributing](../CONTRIBUTING.md).
