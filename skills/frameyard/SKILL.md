---
name: frameyard
description: Edit videos with Frameyard, the local Linux editor, and dapi. Use for shared human/agent timeline editing, local captions, transcript-based cuts, or placing and regenerating Manim and HyperFrames scenes in a Frameyard project.
---

# Frameyard

Use `dapi` with the installed local editor. Projects are folders of Solid JSX;
visual edits write back to those files. Read the current source before each
edit and preserve existing IDs and unrelated manual adjustments.

## Open and inspect

1. Run `dapi context` to identify the current project. Open the requested folder
   with `dapi open /absolute/project/path`; add `--background` to keep it hidden.
   Treat its selected source IDs and selected asset as the referents for “this”
   or “these.” Re-read context when the user changes their selection or playhead.
2. Read `package.json`, its `main` entry, and relevant project files. The MCP
   instructions give the installed docs path. Read its `reference/jsx/README.md`
   and the relevant element or timing page before authoring unfamiliar properties.
3. Inspect footage using `dapi media probe`, `filmstrip`, `grab`, and `waveform`.
   Run `dapi media transcribe /absolute/file` for local word timestamps. Read
   that transcript and selected frames to make editing decisions.

The local build has no hosted account. `models` and `voices` return no hosted
catalog. For footage understanding, reason from local frames and transcripts
with the current agent. External providers require the user's authorization
before uploading their media.

## Edit

Inside the editor's Codex chat, prefer `editor_update` for property/text changes
and `editor_insert_asset` for placement; these use the normal undo history.
Use `editor_context` and `editor_capture` for fresh selection and visual checks.
Existing CLI conversations can call these tools through
`dapi tool <name> --args '<JSON object>'`. Use `dapi capture` when you need an image
file to inspect; `dapi tool` prints its structured result as JSON.
`asset_search` finds candidates; `asset_import` saves a chosen public image with
its source URL. Original images generated with Codex are imported automatically.
Use `hyperframes_catalog` or `hyfrme_catalog` to browse, install, and render
their separate registries. Chat's `catalogReferences` carry the exact provider
and full published manifest, including variables and source file paths. Discuss
those references directly; install source when the user requests an edit.
Components need composition wiring; examples and blocks can render directly. Read installed
source before changing it and verify the resulting asset before placing it.

When chat includes an area annotation, use its frozen image, scene ID, original
time, and normalized rectangle as the reference for “this” or “here.” Multiply
its rectangle by the supplied scene dimensions for source coordinates. Capture
that scene at that time to verify the edit, even if the live playhead has moved.
An area identifies where, not a time range. Apply blur/pixelation to the content
when requested; a zoom changes composition framing rather than editor zoom.

Edit the project's JSX and save; the editor recompiles automatically. Keep one
source of truth. Use native text, shapes, keyframes, and animation presets when
they make the scene directly editable in the timeline.
For vector paths, perspective groups, camera tracks, glass and scene effects,
read `reference/jsx/motion-workspace.md` in the installed docs. Keep each intended
editing target as a named native layer with a stable source ID.

For captions, `<captions preset="whisper" />` transcribes the scene locally.
Alternatively supply `src` pointing to an SRT, VTT, or word-timestamp JSON file.
After a recut, change the caption `seed` to invalidate its scene transcript.

For transcript-driven cuts, read `reference/edit-plan.md` in the installed docs and
run `dapi edit-plan plan.json --output cuts.tsx`. Import the generated component
inside the existing scene. This creates individual editable clips and refuses
to overwrite an existing component. Later changes belong in the current JSX.

For external animation, read `reference/animation.md` in the installed docs. Keep the
Manim or HyperFrames source in the project and register it under
`package.json` → `diffusion.animations`. Run
`dapi animation editable <id> --project /absolute/project/path` when its items
must remain editable. Inspect the reported conversion limits, then import the
generated component into the intended scene. The Animations panel's
**Add editable layers** performs conversion and placement together. Converted
layers use normal timeline edits and undo; retained engine source stays intact.
Verify representative frames against the original and check that the intended
objects are separate native layers. Unsupported features require native
reconstruction or an explicit choice to accept partial conversion.

For an animation the user wants as one media clip, use
`dapi animation render <id> --project /absolute/project/path` and place its
output in a `<video>` node. Regeneration retains source and prior output without
rewriting timeline clips. Its internal objects remain in the engine source.

## Verify and deliver

Run `dapi check <scene-id>` and capture representative frames with
`dapi capture <scene-id> -t 0 2 4`. Inspect those frames, including cut boundaries
and captions, then export with `dapi export <scene-id> /absolute/output.mp4`.
Keep test playback muted.
Export settings live under `diffusion.export` in the project's `package.json`.
Check output duration and audio/video tracks with `ffprobe`. Tell the user the
project location and final video location, with any unverified limitations.

Local setup and recovery instructions live in the repository's `docs/linux.md`;
session and catalog behavior is documented in `docs/agent-workspace.md`.
