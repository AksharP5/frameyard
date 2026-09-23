# `<highlight>`

Enlarge a live region of the layers below this clip and optionally move it to the center. The background dims and blurs while the region lifts out with rounded corners and a shadow. The effect eases in, holds, and returns to the original picture.

```tsx
<scene width={1920} height={1080} active>
  <video src="screen-recording.mp4" width={1920} height={1080} end={12} />
  <highlight
    name="Enlarge the settings"
    start={3}
    end={6}
    region={[0.62, 0.2, 0.25, 0.35]}
    magnification={2}
  />
</scene>
```

Place it after the footage or graphics it should sample. Later siblings draw above the effect. It samples the current composited picture, so source playback, trims, transforms, and overlays below it stay live. It has no media source or audio track.

| Prop | Default | Meaning |
| ---- | ------- | ------- |
| `region` | `[0.25, 0.25, 0.5, 0.5]` | `[x, y, width, height]`, normalized to the parent's frame with a top-left origin. Must fit inside the frame. |
| `magnification` | `1.8` | Enlargement from `1` to `8`. |
| `mode` | `"center"` | `"center"` moves to `destination`; `"in-place"` enlarges around the region's original center. |
| `destination` | `[0.5, 0.5]` | Normalized center of the enlarged region, each coordinate from `0` to `1`. |
| `dim` | `0.45` | Black background overlay, from `0` to `1`. |
| `blur` | `8` | Background blur in composition pixels, from `0` to `100`. |
| `radius` | `12` | Rounded corners in composition pixels, from `0` to `500`. |
| `shadow` | `0.35` | Shadow opacity, from `0` to `1`. |
| `enter`, `exit` | `0.35` | Animation durations in seconds, from `0` to `10`. Both ramps compress proportionally when the clip is shorter than their combined duration. |
| `start`, `end`, `sourceIn`, `sourceOut`, `playbackRate` | see [timing](./timing.md) | Standard clip placement, trimming, and rate. Specify `end` for the desired effect window. |
| `hidden` | absent | Bypass the effect while retaining its timeline clip. |
| `id`, `name`, `selected` | see [elements](./elements.md) | Address, label, and editor selection. |

The effect follows its parent's frame size. Keep its `x` and `y` at zero. It renders at composition resolution before the editor's camera is applied, so a region outside the visible viewport can still move into view. Preview and export use the same renderer, and seeking recomputes the effect from the current frame.

`HighlightOptions`, `HIGHLIGHT_DEFAULTS`, and `parseHighlightOptions` are exported from `@diffusionstudio/jsx` for tools that author the effect.
