# `<path>` and `<ellipse>`

Native vector layers use the same transform, timing, paint, stroke, mask and keyframe controls as a `<rect>`. Every authored path is independently selectable and editable.

```tsx
<path id="curve" x={100} y={100} width={300} height={180}
  viewBox={[0, 0, 100, 60]} d="M 0 30 C 25 0 75 60 100 30">
  <stroke color="#B6C6EC" width={4} cap="round" />
  <keyframeTrack property="d">
    <keyframe time={0} value="M 0 30 C 25 0 75 60 100 30" />
    <keyframe time={1} value="M 0 30 C 25 60 75 0 100 30" />
  </keyframeTrack>
</path>
<ellipse id="dot" x={400} y={250} width={20} height={20} fill="white" />
```

| Path prop | Meaning |
| --- | --- |
| `d` | Required SVG path string. Supports move, line, cubic/quadratic curve, smooth curve, arc and close commands. |
| `viewBox` | Optional `[x, y, width, height]` coordinate rectangle, scaled into the layer's editable box. Width and height must be positive. Without it, `d` uses local pixel coordinates. |
| `fillRule` | `"nonzero"` by default, or `"evenodd"` for holes determined by crossing count. The same rule applies when the path is a mask. |

An ellipse fills its `width` × `height` box. A path or ellipse without a fill or paint draws only its strokes. Either accepts `mask` to clip its parent with its silhouette, including holes; several masks intersect.

A `d` keyframe morphs corresponding coordinates when both strings have the same command and parameter structure. Incompatible structures hold the previous shape until the next keyframe. Changing an arc's discrete flags also holds. Curve control points remain editable in the SVG data; the editor does not currently provide a point or tangent tool on the canvas.

Inside an actual `<svg>` under `<html>`, lowercase `<path>` and `<ellipse>` retain their DOM/SVG meaning. Native layers live outside that SVG subtree.
