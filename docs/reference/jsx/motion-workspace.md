# Editable motion workspace

The project source is the document. Native text, geometry, groups, paints and keyframes appear in the timeline and use the same edit, undo, save and export paths as other layers.

## Start a composition

Open **Catalog**, choose **Motion**, then add a block. It enters the active scene at the playhead, fits the scene's dimensions and stays grouped. If no scene is active, the editor creates one. Expand the group to edit its contents.

The library includes a phone with floating chat messages, kinetic type, a two-series growth chart, a sine curve with a moving point, a studio window with waveform bars, and a cube built from six rectangles. Previews sample the native renderer once; they do not run continuously in the sidebar.

The [motion-workspace example](../../examples/motion-workspace/README.md) contains all six compositions and an 18-second studio opening. Each composition has its own expanded JSX source.

## Edit motion

Select a layer and open **Tools → Inspector**. Transform includes depth and tilt on both axes. Rotate and scale are visible by default. The transform menu exposes anchor, offset and skew.

Canvas handles resize or rotate a spatial layer within its plane. Group resize changes its scale. With several layers selected, resize applies shared ratios to each plane and moves their screen anchors; rotation changes each layer's roll and rotates the anchors together. Tilt and depth remain unchanged during these gestures.

Click the diamond beside a property to add a keyframe at the playhead. Move the playhead and change the value to create the next keyframe. Changes to a property that already has a track update or add a keyframe at the current time. The **Keyframes** section lists the layer's tracks; **Show tracks** expands them in the timeline. Select a timeline diamond to edit its time, value and easing. Path keys expose SVG or XYZ data; point and vertex keys expose numeric arrays.

Native paths use SVG `d` data and an optional `viewBox`. Select a 2D path with the Move tool to drag its anchors and curve handles directly on the canvas. Moving an anchor carries its adjoining cubic handles. The path inspector also accepts SVG data as text, validates edits before saving, and supports nonzero or even-odd fill rules. Canvas edits can be undone and update the path's keyframe at the playhead when it has a track. Keyframes interpolate coordinates when command structure matches; incompatible structures hold until the next keyframe.

```tsx
<scene width={960} height={540} active>
  <group name="Turning panel" x={380} y={170} width={200} height={200}
    end={3} rotationX={-15} rotationY={20}>
    <keyframeTrack property="rotationY">
      <keyframe time={0} value={20} easing="cubicBezier(0.22,1,0.36,1)" />
      <keyframe time={3} value={100} />
    </keyframeTrack>
    <rect name="Panel" width={200} height={200} cornerRadius={24} fill="#B6C6EC" />
    <path name="Mark" x={60} y={60} z={4} width={80} height={80}
      viewBox={[0, 0, 100, 100]} d="M 10 55 L 40 85 L 90 15">
      <stroke color="#283959" width={8} cap="round" join="round" />
    </path>
  </group>
</scene>
```

## Camera and finish

Scene **Camera** controls are distinct from the editor's canvas zoom. They affect playback and export and accept ordinary keyframe tracks. Groups and scenes also expose **Depth order**. The default, **Layer depth**, orders children by their local depth and keeps source order for ties. Choose **Camera distance** for an assembly such as the six cube faces, which must change order as it turns. In JSX this is `depthSort="layer"` or `depthSort="camera"`.

| Property | Default | Meaning |
| --- | --- | --- |
| `z` | 0 | Layer depth in pixels. Positive values move toward the default camera. |
| `rotationX`, `rotationY` | 0 | Layer tilt in degrees. `rotation` remains its rotation around Z. |
| `cameraX`, `cameraY` | Scene center | Camera position in scene coordinates. |
| `cameraZ` | 1000 | Camera distance in pixels. |
| `cameraRotationX`, `cameraRotationY`, `cameraRotation` | 0 | Camera orientation in degrees. |
| `perspective` | 1000 | Focal length in pixels. |
| `cameraZoom` | 1 | Camera magnification. |
| `focusDistance` | 1000 | Distance of the focused plane from the camera. |
| `aperture` | 0 | Depth-of-field blur strength in pixels. |
| `backdropBlur` | 0 | Blur behind a layer, in pixels. |
| `refraction` | 0 | Layer refraction strength, 0–1. |
| `bloom`, `vignette`, `grain` | 0 | Scene finishing strengths, 0–1. |
| `colorSplit` | 0 | Scene chromatic separation in pixels. |

These controls also work with the [native 3D viewport](./spatial.md). A scene3d contains solid meshes, XYZ curves, point clouds, lights, volumes and ordinary native layers under its own camera. Its inspector exposes materials, lighting, fog and physics. The cube library block uses six editable planes; the [native-3d examples](../../examples/native-3d/README.md) demonstrate solid objects, collisions and smoke. Rendering uses realtime raster materials; transparent intersections and volume lighting retain the limits described in the native 3D reference.

Agents can create geometry, paints and keyframes with `editor_add`, then revise returned source IDs with `editor_update`. Both use the normal source writer and undo history. See [native authoring tools](./spatial.md#inspector-and-agent-tools) for the tree format and examples.

## Combine HyperFrames and Manim

In **Animations**, choose **Add editable layers** to sample a registered animation and insert its native group at the playhead. Source files and rendered previews remain available. The operation stops and lists unsupported features before inserting anything. **Convert supported layers** explicitly creates an incomplete version after that report.

For Codex, use `project_animations` with `action: "editable"` and the registered animation `id`. The result includes a new component path, dimensions and conversion report. Import the component into a scene, or author native JSX directly. Do not claim conversion succeeded when the report contains omitted features.

See [animation conversion](../animation.md) for registration, CLI usage and current support. Manim text and formulas become editable glyph paths, so they cannot be retyped as native text. Supported Manim 3D scenes retain XYZ geometry and camera tracks. HyperFrames conversion measures supported layout into explicit coordinates and samples 2D motion and supported planar CSS 3D. Its explicit native export hook can describe geometry that DOM inspection cannot recover. Imported animation does not preserve original procedural expressions or CSS layout rules. Image layers retain their pixels. **Add rendered clip** adds the rendered media as one clip.

The library provides editable starting compositions. Complex designs from
other tools may require native reconstruction or a rendered clip.
