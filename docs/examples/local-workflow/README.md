# Local workflow example

Two editable clips combine a Manim equation animation with an HTML/GSAP title.
Run these commands from the repository root to copy it outside the source tree:

```sh
cp -r docs/examples/local-workflow ~/Videos/local-workflow
cd ~/Videos/local-workflow
curl --fail --location https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js --output animations/hyperframes/gsap.min.js
dapi animation render diagram --project .
dapi animation render title --project .
dapi open .
dapi check demo
dapi capture demo -t 1.5 4.5
dapi export demo demo.mp4
```

Run `npm run setup:local` from the repository first. The Manim equation also
requires the optional TeX packages in the [Linux guide](../../linux.md). GSAP is downloaded once
and remains local thereafter; its upstream license applies.

Select or trim either clip in the editor. Edit its Python or HTML source, then
repeat its `dapi animation render` command. The output path remains the same;
the timeline's JSX and manual adjustments stay intact. The renderer preserves
the previous MP4 as a hidden `.bak` file beside the output.

For transcript-driven editing, transcribe your footage with `dapi media transcribe`,
then author a cut plan as described in [the reference](../../reference/edit-plan.md).
