# Frameyard on Linux

Frameyard is a local desktop editor. The visual editor, project files, media inspection, transcription, and export run on your machine. Codex and Claude Code use your own accounts when you choose to use Assistant. Frameyard does not include Diffusion Studio's hosted generation or audio-analysis services.

The automated release build targets Linux x64. The [portable archive](releases.md) runs without a separate Node installation. Building from source needs Node 22.18 or newer, npm, [uv](https://docs.astral.sh/uv/getting-started/installation/), FFmpeg, Cairo, Pango, and pkg-config. The [README](../README.md) has the source installation steps. On Ubuntu 24.04, the CI workflow installs the system libraries with:

```sh
sudo apt-get install ffmpeg libcairo2-dev libpango1.0-dev pkg-config libasound2t64 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libnss3
```

`npm run setup:local` installs the local Python media tools and downloads the base Whisper model into your user data directory. The first run needs a network connection. Later transcription runs offline. Manim scenes that use mathematical typesetting also need TeX and `dvisvgm`.

`npm run install:linux` builds and installs the app under `~/.local/share/diffusion-studio/`, adds `frameyard` and `dapi` commands under `~/.local/bin`, and registers an application launcher. Existing Diffusion Studio installations retain their older data and command aliases. The installer does not update itself automatically.

## Open a project

Launch Frameyard from your application menu or run `frameyard`. A project is a folder containing `package.json` and an editable JSX entry file. For command-line use:

```sh
dapi open ~/Videos/my-project
dapi context
dapi check main
dapi export main ~/Videos/my-project/final.mp4
```

Use your scene's actual ID in place of `main`. Opening a project compiles its JSX and may load project-local Babel configuration or plugins. Open only projects you trust.

To use OpenCode, open **MCP & CLI** in Frameyard and connect **OpenCode**. Frameyard
adds its authenticated local MCP server to `~/.config/opencode/opencode.json`;
your other OpenCode settings and MCP servers remain in place. OpenCode uses its
own account and runs outside Frameyard's in-app Assistant.

Media imported from outside a project stays at its original location. Before sharing a project, use **Collect project media** in the editor to copy those files into it. [Editing controls](editing-controls.md) covers the timeline, save recovery, export, and media tools.

## Where files go

| Location | Contents |
| --- | --- |
| `~/.local/share/diffusion-studio/releases/` | Installed app versions |
| `~/.local/share/diffusion-studio/current` | Link to the active version |
| `~/.local/share/diffusion-studio/python/` | Local Python and transcription tools |
| `~/.local/share/diffusion-studio/models/` | Downloaded Whisper model |
| `~/.local/share/diffusion-studio/tools/` | Animation CLIs |
| `~/.cache/diffusion-studio/transcripts/` | Transcript cache |
| `~/.frameyard/mcp-token` | Private credential for local agent connections |
| `~/.config/Frameyard/` | Preferences and recent projects on fresh installs |

Existing installations may continue using `~/.config/Diffusion Studio Linux/` for preferences and sessions. New projects default to `~/Videos/Frameyard`; existing projects are not moved. Data and cache paths respect `XDG_DATA_HOME` and `XDG_CACHE_HOME`.

To return to an earlier installed version, quit Frameyard and point `current` at one exact directory under `releases/`:

```sh
ln -s /absolute/path/to/chosen-release ~/.local/share/diffusion-studio/current.next
mv -Tf ~/.local/share/diffusion-studio/current.next ~/.local/share/diffusion-studio/current
```

Keep the version you are returning to until you have reopened a project and checked it. For a release from before the Frameyard rename, launch its `diffusion-studio` executable and its own `resources/cli/bin/dapi`.

## Media limits

Preview can use cached H.264 copies for media the browser cannot decode. Half and Quarter preview quality reduce decoding work; export reads the original media. The compositor is 8-bit SDR. It is not an HDR or high-bit-depth mastering pipeline. Unsupported HDR, unusual rotations, or very large frames can fail native decoding, and some files that FFmpeg can decode may still fail import. [Media authoring](reference/jsx/media.md) explains supported inputs and the preview fallback.

The `DIFFUSION_PYTHON`, `DIFFUSION_HYPERFRAMES_BIN`, `DIFFUSION_WHISPER_MODEL`, and `DIFFUSION_WHISPER_LANGUAGE` environment variables override the corresponding local tools or model. A missing model is not downloaded during transcription; use the setup script to download it first.
