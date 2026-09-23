# Native 3D and physics

`<scene3d>` is an editable 3D viewport inside a scene. Meshes, XYZ paths, point clouds, lights and volumes share its camera and depth buffer. Ordinary text, images, paths and groups can join the same hierarchy. Source edits, inspector changes, keyframes, undo and export use the native document.

Open [examples/native-3d](../../examples/native-3d/README.md) for compositions with lights, collisions and smoke.

```tsx
<scene width={1280} height={720} active>
  <rect width={1280} height={720} fill="#111A22" />
  <scene3d width={1280} height={720} end={6} ambientIntensity={0.4}>
    <mesh name="Box" x={480} y={250} width={240} height={240} depth={240}
      rotationX={-18} rotationY={30} fill="#72B9F1" roughness={0.3}>
      <keyframeTrack property="rotationY">
        <keyframe time={0} value={30} />
        <keyframe time={6} value={390} />
      </keyframeTrack>
    </mesh>
    <light type="directional" x={80} y={-200} z={850}
      targetX={640} targetY={360} intensity={2.5} color="#ECF5FF" />
  </scene3d>
</scene>
```

## Coordinates and camera

Coordinates are local pixels: X points right, Y down and positive Z toward the default camera. Primitive meshes occupy `0..width` and `0..height`, with their depth centered on local Z=0. Custom vertices, path coordinates and point coordinates use their supplied local XYZ values. A layer's `x`, `y`, `z`, pivot, scale and rotation transform those coordinates.

`rotationX` and `rotationY` tilt a layer; `rotation` rolls around Z. Native layer rotations compose as `Ry * Rx * Rz`. Angles are degrees and may exceed 360. The usual anchor defaults to the center of the width/height box. `scaleZ` defaults to 1.

A scene3d owns its camera independently of editor canvas zoom. `cameraX` and `cameraY` default to its center; `cameraZ` and `perspective` default to 1000 pixels. `cameraZoom` defaults to 1. Use `cameraRotationX`, `cameraRotationY` and `cameraRotation` for orientation. `cameraOffsetX` and `cameraOffsetY` shift the projected image in pixels without moving the camera. These properties accept keyframe tracks.

Nested scene3d elements keep their own cameras and appear as editable viewport planes in the enclosing 3D scene. The outer scene's finishing effects apply to the composed result.

Scene3d also supports `focusDistance` and `aperture` for depth-of-field blur, plus `bloom`, `vignette`, `grain` and `colorSplit` finishing controls. These affect both preview and export and accept keyframes.

## Geometry and appearance

| Element | Authored data |
| --- | --- |
| `<mesh>` | `shape`: `box` (default), `sphere`, `plane`, `cylinder`, `cone`, `torus` or `custom`. Primitive dimensions use `width`, `height`, `depth` (default 100 each). |
| `<mesh shape="custom">` | `vertices`: flat XYZ coordinates; `indices`: triangle indices; optional `normals` (XYZ), `uv` (UV pairs) and `vertexColors` (RGBA). Omit normals to derive them. |
| `<path3d>` | `d`: absolute `M`, `L`, `C`, `Q`, `Z` commands with XYZ per point. Cubic segments contain three XYZ points; quadratic segments contain two. Paint and stroke children remain editable. |
| `<pointCloud>` | `points`: flat XYZ coordinates; optional `pointColors`: RGBA per point; `pointSize`: pixels, default 4. |
| `<volume>` | Editable density box sized by `width`, `height`, `depth`; `color`, `density`, `noiseScale`, `flowSpeed` and `scatter` control its appearance. |

Color arrays use components from 0 to 1. `points`, `pointColors`, `vertices` and `vertexColors` accept array keyframes. Equal-length arrays interpolate component by component; changed lengths hold until the next key. XYZ paths animate through `property="d"`; matching command structures interpolate, while incompatible structures hold.

Depth-tested XYZ paths currently tessellate contours separately, so holes require `depthTest={false}` to preserve projected Cairo-style filling. Their tube strokes do not reproduce every 2D cap, join and dash pattern; projected paths retain those 2D stroke semantics.

```tsx
<path3d name="Curve" d="M 0 0 0 C 100 -80 40 180 80 -40 280 0 0">
  <stroke width={5} color="#8ACBFF" cap="round" />
</path3d>
<pointCloud points={[0, 0, 0, 120, 80, 60]}
  pointColors={[1, 0.5, 0.2, 1, 0.2, 0.7, 1, 1]} pointSize={8} />
```

Mesh materials expose `roughness` (default 0.5), `metalness` (0), `transmission` (0), `ior` (1.5), `emissive` and `emissiveIntensity` (0). Roughness, metalness and transmission range from 0 to 1; IOR ranges from 1 to 2.5. `lit`, `castShadow`, `receiveShadow` and `depthTest` default to true; `wireframe` defaults to false. XYZ paths default to unlit. Numeric material controls accept keyframes.

`renderOrder` supplies explicit drawable order. `depthTest={false}` uses painter order when preserving a source animation requires it. Otherwise depth testing resolves opaque geometry across the hierarchy.

Linear and radial gradient paint children support animated endpoints, stops and colors. `gradientSpace="local"` is the default; `"screen"` evaluates the gradient against the projected geometry bounds, including imported Manim gradients. Strokes support `cap`, `join`, `miterLimit`, `dash` and animated `dashOffset`.

## Lights and volumes

`<light type="ambient|directional|point|spot">` defaults to a point light. All lights expose `color` and `intensity`. Directional and spot lights aim at `targetX`, `targetY`, `targetZ`; point and spot lights also expose `distance` and `decay`. Spot lights add `coneAngle` in degrees and `penumbra` from 0 to 1. Directional, point and spot lights can cast shadows.

The scene3d's `ambientIntensity` defaults to 0.4. `fogDensity` defaults to 0 and `fogColor` to white. Volume density defaults to 0.7, noise scale to 3, flow speed to 0.2 and scatter to 0.5. Flow follows local playhead time, so seeking and export reproduce it.

The renderer uses realtime raster materials and depth testing. Transmission and transparent objects use ordinary GPU object sorting; intersecting transparent geometry can show sorting artifacts. Volumes are procedural density fields with approximate lighting, not fluid simulations. Path tracing, environment-map authoring and glTF import are not currently provided. Masks and per-layer filters operate on painted surfaces rather than cutting solid geometry.

## Physics

Add `physics` to a scene, scene3d or group, then `rigidBody` to its layers. The nearest enclosing physics world owns each body; gravity and spring anchors use that world's local coordinates. Authored transforms define the initial pose; simulation changes the displayed pose without rewriting source. Collisions, fixed bodies and springs use a fixed step and deterministic seeking across preview and export.

```tsx
<scene3d width={1280} height={720} end={8} physics={{ gravity: [0, 980, 0] }}>
  <mesh name="Floor" x={160} y={580} width={960} height={30} depth={500}
    fill="#344657" rigidBody={{ type: "fixed" }} />
  <mesh name="Ball" shape="sphere" x={320} y={140}
    width={100} height={100} depth={100} fill="#86C9F1"
    rigidBody={{ shape: { type: "sphere", radius: 50 }, restitution: 0.8,
      velocity: [100, 0, 0] }} />
</scene3d>
```

`physics={true}` uses gravity `[0, 980, 0]` pixels per second squared and `step: 1/120` seconds. A body defaults to `type: "dynamic"`, mass 1, restitution 0.4, friction 0.5, zero velocity and zero damping. Supply `velocity` in pixels per second and `angularVelocity` in degrees per second, both XYZ arrays. `lockRotation` defaults to false. A body participates only during its active timeline interval.

The default collider is a box matching the initial dimensions, or a sphere for a uniformly sized sphere mesh. Use `shape: {type: "sphere", radius}` or `shape: {type: "box", size: [x, y, z]}` to choose an explicit collider. Bodies need positive explicit width and height. Parent groups may translate and rotate with scale 1; rotated parents also need explicit dimensions. Skew, nested rigid bodies and animated body or parent transforms are rejected. Animate material properties independently; moving kinematic colliders are not supported.

For a spring to a fixed scene point, add `spring: {anchor: [x, y, z], stiffness: 100, damping: 10, restLength: 0}` to `rigidBody`. `linearDamping` and `angularDamping` are also available in source. Editing initial conditions rebuilds the simulation. Set `physics={false}` or `rigidBody={false}` through the editor to disable it.

## Inspector and agent tools

The inspector exposes mesh shape, dimensions and material controls; light type, target and intensity; volume settings; scene environment and camera; XYZ path data; and physics gravity, body type, mass, bounce, friction and velocity. Timeline keyframes expose numeric arrays as JSON and XYZ paths as text. Geometry arrays, custom topology and advanced spring settings can be authored directly in JSX or through agent tools.

`editor_add` inserts a native tree into `parentId`, or the active scene when omitted. Children can be geometry, paints, tracks or keyframes. Times in props are seconds. The result returns source IDs for subsequent edits.

```json
{
  "name": "editor_add",
  "args": {
    "parentId": "index.tsx:viewport",
    "tree": {
      "tag": "mesh",
      "props": {"name": "Orb", "shape": "sphere", "width": 120, "height": 120, "depth": 120, "fill": "#86C9F1", "end": 4},
      "children": [{"tag": "keyframeTrack", "props": {"property": "rotationY"}, "children": [
        {"tag": "keyframe", "props": {"time": 0, "value": 0}},
        {"tag": "keyframe", "props": {"time": 4, "value": 180}}
      ]}]
    }
  }
}
```

Use `editor_update` with `{id, props}` to change native geometry, materials, paints, cameras or physics settings. For example, `{id: "index.tsx:orb", props: {roughness: 0.2, metalness: 0.6}}`. Existing tracks receive edits at the playhead, including path strings and coordinate arrays. Keyframe elements also accept direct `time`, `value` and `easing` edits. A call forms one undo step and validates input before changing live layers.

For HyperFrames and Manim, see [editable animation conversion](../animation.md). Conversion reports distinguish supported native geometry from omitted source features; the explicit native export hook handles source scenes that cannot be inferred from DOM pixels.
