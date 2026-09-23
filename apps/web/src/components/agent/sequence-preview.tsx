import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { SequenceDecoder } from "@diffusionstudio/runtime";
import type { SequenceAsset } from "@diffusionstudio/assets";
import { Button } from "@/components/ui/button";

/** Uses the timeline's decoder so the preview preserves the same alpha channel. */
export function SequencePreview(props: { asset: SequenceAsset; active: boolean; onError: (error: unknown) => void }) {
  const asset = props.asset;
  const decoder = new SequenceDecoder(asset, false);
  const lastFrame = Math.max(0, Math.round(asset.duration * asset.frameRate) - 1);
  const [frame, setFrame] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);
  let canvas!: HTMLCanvasElement;
  let disposed = false;
  let generation = 0;
  let pending: number | undefined;
  let decoding = false;
  let presented = 0;
  onCleanup(() => { disposed = true; generation++; pending = undefined; decoder.dispose(); });

  const pause = () => {
    generation++;
    pending = undefined;
    setPlaying(false);
    setFrame(presented);
  };

  const drawNext = async () => {
    const target = pending;
    if (disposed || decoding || !props.active || target === undefined) return;
    pending = undefined;
    decoding = true;
    const current = generation;
    try {
      await decoder.initialized;
      if (disposed || current !== generation) return;
      if (decoder.errored) throw new Error("The animation frames could not be loaded.");
      await decoder.seekTo(target, asset.frameRate);
      if (disposed || current !== generation) return;
      const bitmap = decoder.toBitmap();
      if (!bitmap) throw new Error("The animation frame could not be decoded.");
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      presented = target;
    } catch (error) {
      if (!disposed && current === generation) { pause(); props.onError(error); }
    } finally {
      decoding = false;
      if (pending !== undefined) void drawNext();
    }
  };

  const showFrame = (target: number) => {
    setFrame(target);
    // Keep one latest target while the current frame finishes decoding.
    pending = target;
    void drawNext();
  };

  createEffect(() => {
    if (!props.active) { pause(); return; }
    showFrame(untrack(frame));
  });
  createEffect(() => {
    if (!playing()) return;
    const started = performance.now();
    const first = untrack(frame);
    let request = 0;
    const tick = (now: number) => {
      const next = first + Math.floor((now - started) * asset.frameRate / 1000);
      const target = Math.min(next, lastFrame);
      if (target !== frame()) showFrame(target);
      if (next >= lastFrame) { setPlaying(false); return; }
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(request));
  });

  return <div class="w-full h-full relative" aria-label="Transparent animation preview">
    <canvas ref={canvas} width={asset.width} height={asset.height} class="w-full h-full object-contain" />
    <div class="absolute bottom-0 inset-x-0 flex items-center gap-2 bg-black/80 text-white p-1">
      <Button variant="ghost" class="text-white hover:bg-white/15 hover:text-white" aria-label={playing() ? "Pause animation preview" : "Play animation preview"} onClick={() => {
        if (playing()) { pause(); return; }
        if (frame() === lastFrame) { generation++; showFrame(0); }
        setPlaying(true);
      }}>{playing() ? "Pause" : "Play"}</Button>
      <input aria-label="Animation preview position" type="range" min="0" max={lastFrame} step="1" value={frame()} class="min-w-0 flex-1 accent-primary" onInput={(event) => { pause(); showFrame(Number(event.currentTarget.value)); }} />
      <span class="pr-1 tabular-nums text-xxs">{(frame() / asset.frameRate).toFixed(1)} / {asset.duration.toFixed(1)}s</span>
    </div>
  </div>;
}
