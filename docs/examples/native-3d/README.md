# Native 3D

Open this folder as a Frameyard project. Three eight-second scenes demonstrate solid meshes and lights, simulated gravity and collisions, and ray-marched smoke with an object passing through it.

Every object is a native timeline layer. Select a mesh, light, volume or scene to change its properties in the inspector. Property diamonds create ordinary keyframes. Physics uses the authored initial position and rigid-body settings; seeking to the same time reproduces the same simulation state.

Edit `index.tsx` or use the editor's agent tools to add geometry. The scenes
need no media downloads.

Validate with `npx tsc -p docs/examples/native-3d --noEmit` from the repository root.
