# Effects library

The Effects panel lists the editable presets bundled with this build. Preview
and add a preset to the active scene, or drag it onto the canvas or
timeline. Select a placed effect to change its settings in the inspector. Its
settings and timing stay in the project's JSX; no rendered replacement clip is
needed. The public build includes **Pixelate Region**.

Projects that use preset IDs outside this catalog need the build that supplied
those presets, or must replace them before exporting with this build.

## Placement and editing

A preset works on the composited layers beneath it. Later layers draw above it.
A canvas drop centers the sampled area at the pointer. A
library click uses the marked time range or starts at the playhead. Selecting
**Use with agent** attaches a reference to a draft; it does not edit the scene.

The catalog and its settings are available through `dapi`:

```sh
dapi tool editor_effects --args '{}'
```

Pass an exact ID from that result to `editor_effects` to inspect its controls,
then to `editor_add_preset` with `start` and `end` in scene seconds. The end is
exclusive. `sceneId` defaults to the active scene. The tool returns a source ID;
`editor_update_preset` changes that placed effect without adding another.
`settings` accepts only controls declared for the chosen preset. Effects that
sample an area use normalized `[x,y,width,height]` coordinates.

Pixelate Region is saved as a [`<preset>`](./jsx/preset.md) element.
The separate [`<highlight>`](./jsx/highlight.md) element has its own area and
magnification controls.

## Highlight controls

Highlight enlarges a live region of the scene, moves it toward a destination or keeps it in place, and dims or blurs the surrounding image. It reads the composited visuals beneath its timeline layer. The original clips and audio stay in place. The effect is editable JSX and uses the normal undo history.

Add Highlight with the tool below or author a `<highlight>` element in JSX. Attach a marked area and time range to an agent message when you want to describe the enlargement in words.

Agents and existing CLI sessions use the same tool:

```sh
dapi tool editor_add_highlight --args '{"sceneId":"demo","start":2,"end":5,"region":{"x":0.1,"y":0.2,"width":0.3,"height":0.2},"magnification":2,"mode":"center"}'
```

`sceneId` selects the scene by source ID. Omit it to use the active scene. `start` and `end` are required scene seconds, independent of the playback workarea. End is exclusive. Both snap to scene frames, with a minimum duration of one frame. Placement extends an explicit scene end when necessary and leaves existing clip timing unchanged.

`region` is required and uses normalized top-left coordinates. `x`, `y`, `width` and `height` must describe a positive rectangle inside the frame. Pass an attached `annotation.region` directly. When using frozen attachments, pass their `sceneId`, `sceneSize: {width,height}` and `frameRate` when available; the tool rejects changed scene dimensions or frame rate before editing.

| Option | Default | Meaning |
| --- | --- | --- |
| `magnification` | `1.8` | Enlargement from 1 to 8. |
| `mode` | `"center"` | `"center"` moves toward the destination; `"in-place"` retains the region's center. |
| `destination` | `[0.5, 0.5]` | Normalized target center. |
| `dim` | `0.45` | Background darkness from 0 to 1. |
| `blur` | `8` | Background blur in pixels, from 0 to 100. |
| `radius` | `12` | Corner radius in pixels, from 0 to 500. |
| `shadow` | `0.35` | Shadow strength from 0 to 1. |
| `enter`, `exit` | `0.35` | Animation durations in seconds, from 0 to 10. |
| `name` | `"Highlight"` | Timeline label, numbered when needed. |

The result contains the saved `source` ID, `sceneId`, and snapped `start` and `end`. Revise that effect using `editor_update` instead of adding another:

```sh
dapi tool editor_update --args '{"id":"index.tsx:highlight","props":{"magnification":2.5,"mode":"in-place","end":6}}'
```

Updates accept the options above, an object `region`, and `start` or `end`. Invalid merged timing fails before any properties change. Each add or update is one undo step, including any scene extension. Capture frames before, during, and at the end with `dapi capture --scene-time` to verify placement.

The JSX stores `region` as a tuple `[x,y,width,height]` on a `<highlight>` node directly under the scene, after the visuals it affects. Keep that node last to include all existing visual layers. It does not require a rendered asset or a HyperFrames composition.
