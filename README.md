# Frameyard

Frameyard is a local video and motion editor for Linux. Edit on the timeline or
write a JSX composition, then keep working in either view. Coding agents can use
the same project through the in-app Assistant and `dapi` command-line tools.

Frameyard includes offline speech transcription and captions, source-based cuts,
native 2D and 3D layers, and local Manim and HyperFrames rendering. It is an
independent fork of [Diffusion Studio](https://github.com/diffusionstudio/editor).

## Install

Frameyard currently targets Linux x64. Build and install from source; [portable
archives](docs/releases.md) become available with tagged public releases. The
source install needs Node.js 22.18 or newer, npm, uv, FFmpeg, Cairo, Pango, and
pkg-config.

```sh
git clone https://github.com/AksharP5/frameyard.git
cd frameyard
npm ci
npm run setup:local
npm run install:linux
```

`setup:local` downloads the local Python tools and Whisper model. The installer
builds the app, adds the **Frameyard** launcher, and links `frameyard` and `dapi`
in `~/.local/bin`. Open Frameyard from the application menu or run `frameyard`.
See the [Linux guide](docs/linux.md) for system packages, install paths,
optional Manim TeX support, and rollback.

## Start a project

Create a project in the app, or open a folder from the shell:

```sh
dapi open ~/Videos/my-project
```

For a new folder, this creates a minimal `index.tsx` and `package.json`. The
dashboard's **New project** action adds a README and TypeScript configuration.
Change the scene in the editor or edit the JSX directly. The editor writes
timeline and canvas changes back to the source. Use `dapi context` to see the
open project and playhead, `dapi check <scene-id>` to catch structural issues, and
`dapi export <scene-id> final.mp4` to render. Run `dapi --help` for commands.

Open only projects you trust. Frameyard compiles and runs project code and can
load project-local Babel plugins on your machine.

The **Assistant** panel can connect to your installed Codex or Claude Code CLI.
Agents and the visual editor share project files. Frameyard saves a checkpoint
before each agent turn. [Agent workspace](docs/agent-workspace.md) explains
context, approvals, and recovery.

The default local mode needs no Diffusion Studio account. Speech transcription
runs offline after setup. Diffusion Studio's hosted image, video, voice, and
audio-analysis services are unavailable in local mode. The in-app Assistant
uses your own agent installation and account; those providers may have separate
costs. See [local capabilities and limits](docs/linux.md).

## Learn Frameyard

- [Editing controls](docs/editing-controls.md)
- [Tool and CLI reference](docs/reference/tools/README.md)
- [JSX composition reference](docs/reference/jsx/README.md)
- [Motion workspace example](docs/examples/motion-workspace/README.md)
- [Native 3D and physics example](docs/examples/native-3d/README.md)
- [Manim and HyperFrames workflow](docs/examples/local-workflow/README.md)
- [More composition examples](docs/examples/README.md)

## Develop

```sh
npm run dev
npm run check
npm run lint
npm test
```

`npm run dev` opens the desktop app against Vite. Packaged builds use bundled
files. Build a local package with
`npm run package --workspace=@diffusionstudio/desktop`.

See [Contributing](CONTRIBUTING.md) for pull request checks and release work,
and [Security](SECURITY.md) for private vulnerability reports.

Existing project files keep the `@diffusionstudio/*` package names,
`.diffusion/` folders, and `diffusion` configuration keys for compatibility.
Source is [MPL-2.0](LICENSE). Bundled [Inter](apps/web/public/licenses/Inter-OFL.txt)
and [JetBrains Mono](apps/web/public/licenses/JetBrains-Mono-OFL.txt) fonts
retain their SIL Open Font License 1.1 terms.
