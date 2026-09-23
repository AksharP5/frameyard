# `<preset>`

A placed effect from Frameyard's Effects library. The public build includes
Pixelate Region, which renders the underlying scene through a nearest-neighbor
pixel grid. Browse the catalog in the editor or run:

```sh
dapi tool editor_effects --args '{}'
```

Use the exact ID returned by the catalog in the `preset` prop. An effect added
through the editor writes a `<preset>` element into the project JSX, so that is
also a working example of its settings. Unknown IDs and invalid settings fail
when the project loads; `dapi tool editor_effects` with an `id` shows the
accepted controls for one entry.

`start`, `end`, `sourceIn`, `sourceOut`, `playbackRate`, `name`, `id`, `selected`,
and `hidden` follow the usual [element](./elements.md) and
[timing](./timing.md) rules. `settings` is an object containing only the
controls you want to override. A preset follows its scene's dimensions; keep
it directly under that scene. Effects that sample footage read the composited
siblings below them, while later siblings draw above the effect.

Area controls use normalized frame coordinates. `region` is
`[x,y,width,height]`, with each value from 0 to 1 and the rectangle inside the
frame. `amount` sets the pixel size from 1 to 256. For example:

```tsx
<preset preset="frameyard-pixelate" settings={{ region: [0.25, 0.25, 0.5, 0.5], amount: 16 }} start={1} end={4} />
```

Use [Highlight](./highlight.md) for a live magnified region with its own JSX
element and tool.

`PRESET_CATALOG`, `getPresetDefinition`, `parsePresetOptions`, and the related
types are exported from `@diffusionstudio/jsx` for code that authors effects.
