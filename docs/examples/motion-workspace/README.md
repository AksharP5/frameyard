# Motion workspace

Open this folder as a Frameyard project. It opens on **Studio opening**, an 18-second composition made entirely from native layers and keyframes. It uses the app's Inter font and needs no downloaded assets. No soundtrack is included.

| Time | Composition |
| --- | --- |
| 0–3 s | Staggered opening type |
| 3–9 s | Turning studio window, waveform bars and floating controls |
| 9–15 s | Phone with independently floating chat messages |
| 15–18 s | Closing type |

Six additional scenes contain the individual blocks: **Phone & chat**, **Make it move**, **Growth chart**, **Geometry study**, **Studio launch**, and **Another dimension**. Select a scene to view its timeline. Each scene has a separate file under `compositions/`, including the combined opening, so editing one scene does not change another.

Expand a composition in the timeline, select a layer and open **Tools → Inspector**. Change text, colors, sizes, depth or tilt. Use the property diamonds and the **Keyframes** section to adjust animation. The growth chart morphs SVG paths; the sine study has separate curve and moving-point layers. The waveform is 28 individual animated bars. The cube has six separately editable rectangle faces.

The [motion workspace reference](../../reference/jsx/motion-workspace.md) documents camera, finish, path and keyframe controls. [Animation conversion](../../reference/animation.md) describes how to combine supported Manim and HyperFrames source with these scenes.

The studio compositions use text and native geometry. For solid meshes,
lighting, physics and volumetric smoke, open the [native 3D
example](../native-3d/README.md). Manim glyphs convert as paths, and
unsupported external features require reconstruction.

Validate this example with `npx tsc -p docs/examples/motion-workspace --noEmit` from the repository root.
