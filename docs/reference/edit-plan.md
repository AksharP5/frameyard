# Import an edit plan

```sh
dapi edit-plan "edit/plan.json" --output "My Project/cuts.tsx"
```

Converts an agent's source cuts into an editable Solid JSX component. It writes explicit `<video>` clips inside a `<sequence>`, retaining the original media, source trims, and timeline positions. It needs no running editor or hosted service.

The output must be a new `.tsx` file in an existing folder. Existing files are never overwritten. Generate a new filename for each revision, then review or merge it with your manual edits.

## Plan format

List the source windows to keep, in playback order. Times are numeric seconds; `out` must be greater than `in`, and both must be finite and nonnegative.

```json
[
  { "source": "../footage/take 1.mp4", "in": 2.25, "out": 8, "id": "intro", "label": "Opening" },
  { "source": "../footage/take 1.mp4", "in": 12, "out": 16.5, "id": "demo" }
]
```

Source paths can be absolute or relative to the JSON file. Output references use absolute paths so importing the component from another folder keeps the same source. Media is not copied. The command checks that sources exist and are files; use `dapi media probe` to check their format and duration before choosing cuts.

`id` and `label` are optional. IDs accept letters, digits, hyphens, and underscores and must be unique. `edit-plan` is reserved for the sequence. Without an ID, the command derives one from the source path, trim points, and occurrence count. Reordering distinct source windows retains their IDs; changing a window changes its automatic ID. Supply explicit IDs when revising trims across versions.

The cut subset of [video-use's EDL format](https://github.com/browser-use/video-use/blob/main/helpers/render.py) is also accepted:

```json
{
  "sources": { "take1": "../footage/take 1.mp4" },
  "ranges": [
    { "source": "take1", "start": 2.25, "end": 8, "beat": "Opening" },
    { "source": "take1", "start": 12, "end": 16.5 }
  ]
}
```

Here `start` and `end` are source times. The importer computes consecutive timeline starts. `label`, `beat`, or `note` can name a clip, in that precedence order. Other fields are rejected: grading, overlays, subtitles, and audio processing must be added in the editor.

## Use the component

Import it into the existing project's entry file and place it inside a scene:

```tsx
import EditPlan from "./cuts";

export default function Project() {
  return (
    <stage>
      <scene name="Rough cut" width={1920} height={1080} active>
        <EditPlan />
      </scene>
    </stage>
  );
}
```

Generated clips use 1920×1080 boxes. Resize them in the editor or JSX for a different aspect ratio. Each clip remains a literal element, so manual trims, movement, and property edits write back to the generated file.

After importing, run `dapi check`, inspect the cuts with `dapi capture`, and export the scene when ready.
