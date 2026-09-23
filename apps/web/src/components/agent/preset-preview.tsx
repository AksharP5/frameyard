import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { parsePresetOptions, type PresetDefinition } from "@diffusionstudio/jsx";
import { renderPresetEffect } from "@diffusionstudio/runtime";

const width = 640, height = 360;
let sample: HTMLCanvasElement | undefined;

function previewSource() {
  if (sample) return sample;
  sample = document.createElement("canvas");
  sample.width = width;
  sample.height = height;
  const ctx = sample.getContext("2d")!;
  ctx.fillStyle = "#13171c";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#252e38";
  ctx.fillRect(36, 32, 568, 296);
  ctx.fillStyle = "#34485c";
  ctx.fillRect(300, 66, 266, 224);
  ctx.fillStyle = "#688cac";
  ctx.beginPath(); ctx.arc(440, 178, 64, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#202d3d";
  ctx.beginPath(); ctx.moveTo(310, 290); ctx.lineTo(421, 172); ctx.lineTo(566, 290); ctx.fill();
  ctx.fillStyle = "#ecf1f6";
  ctx.font = "600 25px sans-serif";
  ctx.fillText("Frameyard", 65, 100);
  ctx.fillStyle = "#657484";
  for (const [x, y, length] of [[65, 124, 166], [65, 142, 128], [65, 184, 180], [65, 202, 147], [65, 220, 169]]) ctx.fillRect(x!, y!, length!, 7);
  ctx.fillStyle = "#97b6ce";
  ctx.fillRect(65, 263, 97, 23);
  return sample;
}

/** Draw the effect only when its preview enters the viewport. */
export function PresetPreview(props: { definition: PresetDefinition; large?: boolean }) {
  let canvas!: HTMLCanvasElement;
  const [visible, setVisible] = createSignal(false);
  const [error, setError] = createSignal("");
  onMount(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false));
    observer.observe(canvas);
    onCleanup(() => observer.disconnect());
  });
  createEffect(() => {
    if (!visible()) return;
    const definition = props.definition;
    setError("");
    const options = parsePresetOptions({ preset: definition.id });
    canvas.width = props.large ? width : width / 2;
    canvas.height = props.large ? height : height / 2;
    const ctx = canvas.getContext("2d")!;
    const source = previewSource();
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    try {
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(source, 0, 0);
      renderPresetEffect(ctx, source, options, width, height);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  });
  return <div><canvas ref={canvas} aria-hidden="true" class="block aspect-video w-full rounded-sm bg-[#13171c]" /><Show when={error()}><p role="alert" class="p-2 text-xs text-destructive">{error()}</p></Show></div>;
}
