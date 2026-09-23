# Examples

The standalone `.tsx` files show the [JSX composition API](../reference/jsx/README.md).
To open one, copy it into its own project folder. Run these commands from the
repository root:

```sh
mkdir -p ~/Videos/frameyard-basics
cp docs/examples/01-basics.tsx ~/Videos/frameyard-basics/index.tsx
dapi open ~/Videos/frameyard-basics
```

`01-basics.tsx` loads example footage from the internet. For an offline first
project, open the [native 3D example](native-3d/README.md) or the [motion
workspace](motion-workspace/README.md).

| Example | Shows |
| --- | --- |
| [motion-workspace](motion-workspace/README.md) | An 18-second native opening and six editable motion compositions: type, charts, geometry, spatial UI and a six-face cube |
| [native-3d](native-3d/README.md) | Editable solid meshes, lighting, gravity and collisions, and volumetric smoke |
| [local-workflow](local-workflow/README.md) | Local Manim and HyperFrames sources, rendering, and editable timeline clips |
| [01-basics.tsx](01-basics.tsx) | `<stage>` / `<scene>`, `<sequence>` with a dissolve, `<video>`, `<audio>`, `<image>`, `<text>` titles from data via `<For>`, `<animation>` children |
| [02-genai.tsx](02-genai.tsx) | Hosted generation API example; unavailable in Frameyard's default local mode |
| [03-ticker.tsx](03-ticker.tsx) | declarative animation: `useTicker` + `createMemo` derived values driving props |
| [04-html-in-canvas.tsx](04-html-in-canvas.tsx) | `<htmlPaint>`: an AI prompt box as real DOM, typed out from the playhead |
| [05-anime-timeline.tsx](05-anime-timeline.tsx) | anime.js timeline seeked from `useTicker`, driving an ECS node and `<html>` content in lockstep |
| [06-three.tsx](06-three.tsx) | three.js WebGL renderer owning a `<surface>`, glTF model loaded over the network |
| [07-webgpu.tsx](07-webgpu.tsx) | raw WebGPU on a `<surface>`: a triangle whose colors cycle with composition time |
| [08-shader-paint.tsx](08-shader-paint.tsx) | `<shaderPaint>` post-processing a `<video>`: WGSL chromatic aberration + vignette, uniforms patchable live |
| [09-inspect-variables.tsx](09-inspect-variables.tsx) | `@inspect` variables: annotated top-level consts becoming sidebar controls, values written back into the source |
| [10-typegpu.tsx](10-typegpu.tsx) | TypeGPU on a `<surface>`: shaders written in TypeScript (`'use gpu'`), compiled through the project's own [babel config](../reference/jsx/module.md#compile-time-plugins-babel-config) |
| [11-redraw.tsx](11-redraw.tsx) | [Redraw](https://redraw.dev) on a `<surface>`: the docs' Hello World write-on stroke, a vendored-tarball package driven by composition time; the surface spans one animation cycle, `@inspect` variables tune it, and `useResolution` keeps it sharp at any export size |

`01-basics.tsx`, `06-three.tsx`, and `08-shader-paint.tsx` fetch remote media.
`02-genai.tsx` documents the inherited hosted API, but it cannot run in local
mode. Generate media with a separate tool and import the resulting files into
your project.
`05-anime-timeline.tsx` needs `animejs` installed in its project folder;
`06-three.tsx` needs `three`. `10-typegpu.tsx` and `11-redraw.tsx` need packages
and a Babel config next to the entry. Their header comments include commands.
`11-redraw.tsx` additionally needs the `redraw` tarball vendored into the project
([Redraw is in technical preview](https://redraw.dev/docs/installation)).

From the repository root, `npm run check` typechecks the examples that use
bundled dependencies. `npm run check:examples` also checks optional integrations
available in the repository workspace. A copied project needs its own
dependencies installed as described above.
