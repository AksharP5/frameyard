# Retained animations

Create and revise Manim or HyperFrames animations, preview them in **Animations**, and export individual clips for Resolve or assemble a launch video in the editor. Convert supported objects into native layers when you need to edit their contents on the timeline. The CLI works without the editor running and uses the installed local tools.

## Editable native layers

```sh
dapi animation editable diagram --project ./my-video
dapi animation editable title --project ./my-video
```

Conversion executes the registered source with the installed local engine and writes a **new native JSX component** under `animations/`. Import that component into a scene or use its literal group in the project. Every converted container, text object, image, vector path, paint and keyframe uses the editor's ordinary layer model. The component retains its original frame dimensions and a rectangular clipping mask, so transparent compositions can be combined with other graphics without spilling outside their frame. Original Python/HTML, existing native variations, and rendered previews remain intact. Converting again creates a separate variation; it does not replace your manual edits.

In **Animations**, **Add editable layers** converts the source and inserts the resulting native group at the playhead. A failure reports the unsupported features before inserting anything. **Convert supported layers** explicitly accepts an incomplete version. Agents can use `project_animations` with `action: "editable", id: "diagram"`; the tool creates the component and returns its output path and conversion report without automatically inserting it.

Manim's Cairo vectors become editable cubic paths, including glyph outlines from `Text` and `MathTex`. Conversion samples object hierarchy, geometry, fills, linear gradients, strokes, caps/joins, background strokes and painter order. `MovingCameraScene` motion becomes position and size tracks. `ThreeDScene` preserves XYZ paths, surface faces and camera tracks inside a native `scene3d`. Images become separate native image layers with embedded PNG data; point clouds retain editable XYZ positions, RGBA colors and point size. Fixed-in-frame and fixed-orientation objects retain their appearance through sampled camera compensation. That compensation becomes geometry keys, so a later camera edit does not recreate the original fixed-object constraint.

Manim glyph outlines retain their geometry, **not a retypable text string**. Change text or formulas in Python and convert a new variation, or author native text when typing changes matter. Strict limits include OpenGL/custom renderers, custom or exponential camera projection, image-filled vectors, changing image pixels, non-planar image corner warps, and 2D painter order that interleaves children across separate groups. Source expressions and simulation rules become sampled motion, not live native constraints.

HyperFrames conversion samples registered GSAP timelines and document-based CSS/Web Animations timelines. HTML containers retain their measured layout, editable text lines, image layers, solid fills, uniform borders, circular corner radii, overflow clipping and affine transforms, including skew and individual translate/rotate/scale properties. Wrapped HTML text becomes separate editable lines. Linear and elliptical radial backgrounds become native gradient paints with editable stops and geometry. Supported CSS filters become native effects: blur, brightness, contrast, grayscale, hue rotation, invert, saturation and sepia. Basic `clip-path` inset, circle, ellipse, polygon and path shapes become native masks.

Inline SVG supports `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `text`/`tspan`, and nested `g` groups. ViewBox scaling, alignment, affine transforms, fill rules, gradient fills/strokes and dashed strokes are retained. One fixed path viewBox spans animated bounds; gradient and clip coordinates follow that same frame. Text gradients span the whole SVG text element across ordinary tspan runs. A local `clipPath` with one supported geometry becomes a native mask.

CSS 3D affine transforms on direct children of a `perspective` container become native planar layers inside `scene3d`. Translation in Z, XYZ rotations, XY skew, scale, transform origin and perspective origin are retained. The perspective container must be the composition root or clip both axes. Ordinary 2D descendants remain editable on the transformed plane. Embedded `perspective()` transforms, nested 3D/flattening contexts, `preserve-3d` depth sorting, hidden backfaces, depth shear and singular 3D transforms require an explicit native capture hook described below.

CSS layout becomes explicit native coordinates; imported objects no longer run flex/grid layout after conversion. Native text remains retypable. Browser and native font rendering can differ, and used `@font-face` fonts are reported until a matching native font is verified. Image pixels and embedded SVG image files are not decomposed.

Automatic HyperFrames capture still reports Canvas/WebGL and video/audio content, external nested compositions, pseudo-elements, shadows/backdrop filters, blend/stacking changes, changing text or font properties, unsupported background geometry, repeating/conic gradients and SVG patterns. Other strict limits include SVG filter graphs, masks, multi-geometry clip unions, markers, non-scaling strokes, nested SVG viewports, `use`, SVG `image`, `textPath`, per-character positioning and transformed tspan gradients. Bidirectional/vertical HTML text, elliptical border corners, changing clip presence or gradient stop counts, and visibility overrides below hidden ancestors also require reconstruction. Supply native capture data for custom engines, rebuild the reported features as native objects, or keep the source-rendered preview.

**Conversion fails if a rendering feature cannot be represented.** No partial component is published by default. For an intentionally incomplete starting point:

```sh
dapi animation editable title --project ./my-video --allow-partial
```

The JSON response includes `output`, `width`, `height`, `duration`, `frameRate`, `layerCount`, `keyframeCount`, and an `issues` list naming unsupported layers/features. The desktop bridge also receives an ordinary `AuthoredTree` for direct insertion; this is transient transport, not a second saved project format. A partial conversion retains that report in the response. Keep it with your task notes until the unsupported features have been rebuilt.

Numeric sample tracks are reduced within 0.01 property units (0.0001 for opacity), preserving pauses and extrema. Repeated path samples are removed; compatible path geometry interpolates, and incompatible topology holds until the next sample. This preserves editable motion at the sampled frame rate; it does not recover the original procedural expressions or GSAP easing declarations. Automatic samplers stop at 500,000 object samples. Capture files larger than 128 MB fail. Split larger compositions into shorter components.

HyperFrames conversion uses the installed HyperFrames `puppeteer-core` dependency and an existing Chromium at `/usr/bin/chromium`, `/usr/bin/chromium-browser` or `/usr/bin/google-chrome`. Set `DIFFUSION_CHROMIUM_BIN` to select another installed browser. It never downloads or installs a browser. Manim uses the same `DIFFUSION_PYTHON` override as rendering.

## Custom source capture

A HyperFrames document can expose `window.__DIFFUSION_EDITABLE__` when its own engine can supply native objects. This bypasses automatic DOM capture. The value may be a capture object, a Promise of one, or an async function receiving the requested `{ frameRate }`. A hook-only document does not need a `data-composition-id` root or GSAP timeline.

The hook supplies geometry and keyframes directly. It does not recover editable objects from Canvas, WebGL or video pixels. For example, a custom particle renderer can expose its particle state:

```html
<script>
window.__DIFFUSION_EDITABLE__ = async ({ frameRate }) => ({
  width: 640,
  height: 360,
  duration: 2,
  frameRate,
  issues: [],
  layers: [
    {
      id: "world",
      kind: "scene3d",
      name: "Particle world",
      frames: [{
        time: 0,
        props: { width: 640, height: 360, cameraZ: 1000, perspective: 1000 }
      }]
    },
    {
      id: "particles",
      parent: "world",
      kind: "pointCloud",
      name: "Particles",
      frames: [
        {
          time: 0,
          props: {
            points: [220, 180, 0, 420, 180, 0],
            pointColors: [1, 0.3, 0.1, 1, 0.2, 0.6, 1, 1],
            pointSize: 12,
            opacity: 1
          }
        },
        { time: 2, props: { points: [280, 120, 80, 360, 240, -80] } }
      ]
    }
  ]
});
</script>
```

`width`, `height`, `duration`, `frameRate`, `layers` and `issues` are required. Dimensions are pixels; duration and frame times are seconds. List parents before their children, give every layer a unique nonempty `id`, and order each layer's frames by time within the capture duration. Each layer requires `kind`, `name` and at least one frame. Omitted later properties retain their previous value. Use finite numbers; point/vertex coordinates are flat XYZ arrays, point/vertex colors are flat RGBA arrays, and UV coordinates are pairs.

Supported capture kinds are `group`, `rect`, `ellipse`, `text`, `image`, `path`, `scene3d`, `path3d`, `pointCloud`, `mesh`, `light`, `volume`, `solidPaint`, `linearGradientPaint`, `radialGradientPaint`, `colorStop`, `stroke`, `effect` and `shadow`. Paints, color stops and effects are child layers. Native 3D paths use absolute `M`, `L`, `C`, `Q` and `Z` commands with XYZ coordinates per point. Gradient endpoints/centers/radii use normalized parent-local coordinates. Use `text` in a text layer's frame props and `src` for image assets. See the [motion workspace](jsx/motion-workspace.md) for native spatial properties.

The shared capture validator checks the hierarchy, known kinds/properties, finite values, array dimensions and 3D path syntax before publishing JSX. Fields that cannot be animated produce conversion issues when their values change. Put source-specific limitations in `issues` as `{ layer: "Layer name", feature: "Unsupported behavior" }`; they prevent publication unless the caller explicitly accepts partial conversion. The hook result is transient input. The saved artifact is the same native JSX component as an automatic conversion.

## Source previews and standalone export

Register each animation in the project's `package.json`:

```json
{
  "diffusion": {
    "animations": {
      "diagram": {
        "engine": "manim",
        "source": "animations/diagram",
        "entry": "scene.py",
        "scene": "Diagram",
        "output": "assets/diagram.mp4"
      },
      "title": {
        "engine": "hyperframes",
        "source": "animations/title",
        "frameRate": 60,
        "output": "assets/title.mp4"
      }
    }
  }
}
```

```sh
dapi animation render diagram --project ./my-video
dapi animation render title --project ./my-video
dapi animation list --project ./my-video
dapi animation export title exports/title.mp4 --project ./my-video
```

`source` is a directory relative to the Frameyard project. A Manim `entry` is relative to that source directory; `scene` names one Python class. A HyperFrames source defaults to `index.html`; optional `entry` selects another relative HTML path. Website templates retain `__template_baseline__.html` unchanged. Paths must stay within the project and cannot traverse symbolic links. `output` must be outside the source directory. Opaque renders use `.mp4`. Either engine supports `"transparent": true` with output such as `"assets/diagram.frames"`. Leave backgrounds transparent in the source. The numbered PNGs and hidden `.sequence.json` metadata form one asset, preserving alpha and frame rate. Keep the folder intact. Parent output directories are created after validation.

Open **Animations** to browse registered HyperFrames, Hyfrme and Manim work, including unrendered sources. **New animation** offers **HyperFrames animation**, **Manim animation**, and **Browse catalog**. The **Catalog** collection selector offers Motion, HyperFrames, Templates, and Hyfrme. **Render preview** generates the selected animation; play and scrub it, then **Revise in chat** for revisions. **Add rendered clip** fits the preview inside the active scene. **Export animation** saves a standalone clip, even without a scene. **Files** offers **Show source** and **Show preview file**; **Show export** reveals the exported clip. **Cancel** stops a render, export or conversion and keeps the previous output.

Agents in Frameyard can use `project_animations` with `action: "list"`,
`action: "render", id: "diagram"`, `action: "cancel", id: "diagram"`, or
`action: "export", id: "diagram", output: "exports/diagram.mov"`; the current project directory is supplied by
Frameyard. Existing terminal sessions can use
`dapi tool project_animations --args '{"action":"list"}'` or the commands above.
The tool returns validated registrations, render timestamps, and `libraryPath`
for `editor_insert_asset`. Use `fit: "contain"` to fit an animation inside its scene.
A broken registration shows its own error without hiding the other animations.
Keep outputs inside `assets/` to enable timeline insertion.

Optional `frameRate` accepts 1–240 fps. Manim uses Cairo at 1080p and defaults to 30 fps. HyperFrames uses the composition's dimensions and its rendered frame rate unless overridden, with one worker and low memory mode. Installed catalog blocks retain their declared `data-fps` in the generated host composition. Multiple catalog installs can run together; each registration preserves the others. Sequences without metadata retain the legacy 30 fps default. HyperFrames lint errors or unready media fail the render. The adapter disables HyperFrames telemetry for its child process. Compositions can still request external assets named in their source.

Standalone export supports MP4 for opaque clips and ProRes 4444 MOV for transparent overlays. Frame rate and duration are preserved. Export requires a successful preview and does not insert anything into a scene. Output paths may be absolute or project-relative. Existing files require `--overwrite` on the CLI; the editor uses the save dialog's overwrite confirmation. Failed exports preserve an existing destination. Ctrl+C cancels a CLI render or export. Quitting Frameyard cancels its active animation jobs and waits for their processes and temporary files to be cleaned up.

Place the rendered file on the timeline once:

```tsx
<video id="diagram" src="assets/diagram.mp4" start={4} sourceIn={0} sourceOut={3} />
```

To revise it, edit `animations/diagram/scene.py` and run the same command again. The command replaces the rendered output after a successful render and leaves the JSX, clip timing, and animation source in place. The editor's file watcher refreshes the asset when the new file lands. Keep the generated scene long enough for the timeline's existing trim.

An existing MP4 is copied to `assets/.diagram.mp4.<unique-id>.bak` before replacement. The hidden backup stays out of the editor's media library. Transparent frame folders are retained as hidden `.bak` folders before replacement. Failed renders leave the previous output intact. Intermediate rendering files are removed. Backups remain until you choose to remove them.

Progress goes to stderr. Success prints one JSON object:

```ts
{
  id: string;
  engine: "manim" | "hyperframes";
  transparent: boolean;
  source: string;  // absolute source directory
  output: string;  // absolute movie file or .frames directory
  backup?: string; // previous rendered output, when replaced
}
```

The default tools live under `${XDG_DATA_HOME:-~/.local/share}/diffusion-studio`: `python/bin/python` for Manim and `tools/node_modules/.bin/hyperframes` for HyperFrames. The local installer pins HyperFrames to `0.8.59`, Hyfrme to `0.4.0`, and Manim to `0.21.0`. The catalog preview player uses the matching HyperFrames release. Run `npm run setup:local` after updating the repository to upgrade existing managed tools. Set `DIFFUSION_PYTHON` or `DIFFUSION_HYPERFRAMES_BIN` to use another installed executable. These variables take executable paths, with arguments passed separately by the adapter. Rendering never installs dependencies or runs a shell command from the project manifest.

A transparent Manim registration:

```json
{
  "engine": "manim",
  "source": "animations/diagram",
  "entry": "scene.py",
  "scene": "Diagram",
  "frameRate": 60,
  "transparent": true,
  "output": "assets/diagram.frames"
}
```

The Animations view shows a checkerboard behind transparent pixels. It is preview-only
and is not included in the render. The renderer uses a transparent MOV intermediate
and local FFmpeg to preserve still-frame holds and write PNGs with straight alpha.
Frame sequences contain visuals only; keep narration and sound effects as separate audio clips. They use more disk space than MP4. Keep the complete folder together;
re-rendering updates existing clips without changing their timing.

Render and export jobs recheck the animation registrations before publishing.
If a registration changes during rendering, the job stops and keeps the previous
preview. Exports cannot replace an output newly registered while the job was running.
