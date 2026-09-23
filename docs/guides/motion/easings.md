# Easings

Six useful curves for `<keyframe>` easing. Choose by the motion you want and
preview at the scene's frame rate. `linear` is still useful for constant-speed
movement; the [keyframe reference](../../reference/jsx/keyframes.md#easing)
lists the other presets and custom syntax.

| Easing | Value | Use for |
| --- | --- | --- |
| `snappyOut` | `cubicBezier(0,0.6,0.4,1)` | Energetic entrances that settle softly |
| `expoOut` | `cubicBezier(0,1,0,1)` | Dramatic reveals, scale pops, counters |
| `snappyIn` | `cubicBezier(0.6,0,1,0.4)` | Wind-ups that exit at full speed |
| `expoIn` | `cubicBezier(1,0,1,0)` | Anticipation into a hard exit or cut |
| `outIn` | `cubicBezier(0,0.7,1,0.3)` | Motion carried across a cut, whip feel |
| `inOut` | `cubicBezier(0.7,0,0.3,1)` | A-to-B moves at rest on both ends |

Across a cut, alternate them so objects are at their highest velocity at the moment of the cut: ease in to animate out, followed by ease out for the reveal.

To carry motion across a cut, ease the outgoing layer in toward the cut and
ease the incoming layer out of it. Check both sides with `dapi capture` at
adjacent frames. A small move stretched over a long interval can look static at
the intended size, even when its values change every frame.
