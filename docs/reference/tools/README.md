# Tool reference

Frameyard exposes one set of tools, reachable two ways:

- **MCP.** The running app serves MCP over Streamable HTTP on loopback. Connect agents in Frameyard's Agents settings, or copy the authenticated URL shown there for another HTTP client. Keep that URL private: it grants control of the editor. Agents that only support stdio can run `dapi mcp`. A connected agent gets every tool in `tools/list`, with the descriptions on these pages and its input and output as JSON Schema 2020-12, and instructions that give the path of these docs in the installed app.
- **CLI.** `dapi`, the command-line client shipped with the app, wraps every tool as a command for shells, scripts and CI. `dapi <command> --help` prints the same description and the same field help.

Both validate against the same schemas and return the same result, so each tool is documented once, on its own page. The catalog behind all three (server, CLI, these pages) lives in `packages/dapi`.

The JSX code syntax specified in [jsx/](../jsx/README.md) is **pseudo-SVG**, mirroring SVG's shape-and-paint model with the editor's own tags and props rather than the SVG spec. A project is a folder of that JSX, and **the source is the document**: the app compiles the entry file and renders every element into an editable node, and edits made on the canvas are written back to the element that authored them. So the loop is [`open`](./open.md) once, then edit the files — there is no tool that pushes content into the app. What the tools do is read the running app ([`context`](./context.md), [`capture`](./capture.md), [`logs`](./logs.md)), inspect media, and list what a declaration may name.

## Names

A tool is named as MCP lists it, and the CLI spelling follows from the name:

- Media commands are top-level: `grab` is `dapi grab`. Existing `dapi media grab` and `dapi m grab` invocations and `media_grab` MCP names remain compatibility aliases.
- A tool's first field is the positional argument: `capture`'s `id` is `dapi capture <id>`.
- Every other field is an option in kebab-case: `perSheet` is `--per-sheet`, `separate` is `--separate`. Short forms are listed on each page.
- Times are written the same way everywhere: seconds (`1.5`), frames at the project's rate (`45f`), or a clock string (`1:30`, `00:01:30`). Times in **results** are plain seconds.

## Results

Every tool returns one JSON object, its *structured content*. Over MCP that is the result's `structuredContent`, repeated as a text block for clients that ignore structured content; the CLI prints it to stdout, unchanged. Tools that render images (`capture`, `grab`, `filmstrip`, `waveform`, `media_segment`, `screenshot`) write PNGs to disk and return their paths; over MCP a result of at most four images, none over a megabyte, also carries them inline as image content, so a contact sheet arrives in context without opening anything.

## Errors

A failure is a sentence written to be read, e.g. `No project open — run open first`. Over MCP it arrives as a tool result with `isError: true`, not as a protocol error; the CLI prints it to stderr and exits `1`. Each page's Errors section lists what the tool fails on; only the delivery differs by surface.

Every tool runs inside the app, so the app has to be running. Over MCP that is a given. From a shell, `dapi open` launches or surfaces Frameyard on Linux. Other commands print a launch instruction and exit `1` while the app is down.

Frameyard's default local mode has no Diffusion Studio account or hosted generation
service. `models` and `voices` return empty lists, `whoami` returns `null`, and
`listen` is unavailable. Local transcription, media inspection, capture,
editing, and export still work. See [local setup](../../linux.md).

## The tools

| Tool | CLI | Does |
| --- | --- | --- |
| [`open`](./open.md) | `dapi open` | Open project |
| [`workspace`](../../agent-workspace.md#parallel-videos) | `dapi workspace` | Manage parallel projects and agents |
| [`context`](./context.md) | `dapi context` | App context |
| [`capture`](./capture.md) | `dapi capture` | Capture frames |
| [`check`](./check.md) | `dapi check` | Check structure |
| [`export`](./export.md) | `dapi export` | Export scene |
| [`probe`](./probe.md) | `dapi probe` | Probe media |
| [`grab`](./grab.md) | `dapi grab` | Grab frames |
| [`transcribe`](./transcribe.md) | `dapi transcribe` | Transcribe speech |
| [`filmstrip`](./filmstrip.md) | `dapi filmstrip` | Filmstrip preview |
| [`waveform`](./waveform.md) | `dapi waveform` | Waveform preview |
| [`listen`](./listen.md) | `dapi listen` | Hosted audio analysis; unavailable in local mode |
| [`media_segment`](./media/segment.md) | `dapi segment` | Segment and track an object locally |
| [`generate`](./generate.md) | `dapi generate` | Start hosted generation or local SAM tracking |
| [`job`](./job.md) | `dapi job` | Poll or cancel a generation job |
| [`agent_tool`](../../skills/editor.md) | `dapi tool` | Use native editor tools |
| [`models`](./models.md) | `dapi models` | Hosted generation models; empty in local mode |
| [`voices`](./voices.md) | `dapi voices` | Hosted speech voices; empty in local mode |
| [`whoami`](./whoami.md) | `dapi whoami` | Hosted account; null in local mode |
| [`logs`](./logs.md) | `dapi logs` | App logs |
| [`screenshot`](./screenshot.md) | `dapi screenshot` | Window screenshot |
| [`window`](./window.md) | `dapi window` | Show or hide the app window |
| [`fonts`](./fonts.md) | `dapi fonts` | Fonts |
| [`report`](./report.md) | `dapi report` | Report a bug |

How the surface is divided:

- **The project loop.** [`open`](./open.md) a folder, edit its JSX, [`context`](./context.md) for what the source cannot say, [`capture`](./capture.md) and [`check`](./check.md) to verify, [`export`](./export.md) when asked.
- **Media inspection**: a file by path, without adding it to the project. Absolute paths and URLs work with or without an open project; library paths (`b-roll/clip.mp4`) need one.
- **Masks.** [`media_segment`](./media/segment.md) segments and tracks an object in footage and writes the mask file a `<mask src>` names.
- **Generation.** [`generate`](./generate.md) starts a job; [`job`](./job.md) reports or cancels it. The [model reference](../models.md) lists its fields. Local `sam-2.1` works without an account; API models need a hosted build and account.
- **What a declaration may name.** [`fonts`](./fonts.md) lists installed fonts. In a hosted build, [`models`](./models.md) and [`voices`](./voices.md) list choices for [`generate.*`](../jsx/generate.md).
- **The app and the machine.** [`whoami`](./whoami.md), [`logs`](./logs.md), [`screenshot`](./screenshot.md), [`window`](./window.md), [`report`](./report.md).

## Downloading footage

There is no download tool, and none is needed: run **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** from a shell. It handles YouTube, TikTok, Instagram, Vimeo, X, direct media links and most other sites, and a download that lands under the project's `assets/` folder is a library asset (see [jsx/media.md](../jsx/media.md)).

## Shared types

```ts
Asset = { id: string; path: string; type: string }  // asset ids are content hashes; `path` is the library path
Time  = number | `${number}f` | "MM:SS"              // seconds, frames at the project's rate ("45f"), or a clock string; see jsx/timing.md
NodeId = string                                     // an element's `id` in the project's JSX; `file:id` (`intro.tsx:hero`, the file name with its extension) when two files collide
```

Time inputs take the `Time` format unless noted otherwise.

For a numeric JSX ID, use `file:#id` when qualifying it, such as `intro.tsx:#2`
for `id="2"`. Source references returned by the editor already use this form.
