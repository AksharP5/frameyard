import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { createRuntimeDocument, insert, renderAuthored, withDocument } from "@diffusionstudio/reconciler";
import { Mode, RenderSurface, createRuntimeWorld, getActiveEntity, motionSystem, playbackSystem, renderSystem, setCameraMatrix, setPlayhead, transformSystem } from "@diffusionstudio/runtime";
import { MOTION_BLOCKS, motionBlockTree, type MotionBlock } from "@/engine/motion-blocks";
import { insertMotionBlock } from "@/engine/motion-library";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

function MotionPreview(props: { block: MotionBlock }) {
  let canvas!: HTMLCanvasElement;
  const [error, setError] = createSignal("");
  let disposed = false;
  onCleanup(() => { disposed = true; });
  onMount(() => {
    void document.fonts.load("600 32px Inter").then(() => {
      if (disposed) return;
      const world = createRuntimeWorld(`motion-preview:${props.block.id}`);
      const document = createRuntimeDocument(world);
      try {
        world.set(Mode, { value: "offline-video" });
        world.set(RenderSurface, { canvas, ctx: canvas.getContext("2d"), resolution: 1 });
        setCameraMatrix(world, [canvas.width / 1920, 0, 0, canvas.height / 1080, 0, 0]);
        withDocument(document, () => insert(document.stage, renderAuthored({ tag: "scene", props: { width: 1920, height: 1080, active: true }, children: [motionBlockTree(props.block)] })));
        const scene = getActiveEntity(world);
        if (!scene) throw new Error("Preview scene could not be created.");
        setPlayhead(world, scene, 72);
        playbackSystem(world);
        motionSystem(world);
        transformSystem(world);
        renderSystem(world);
      } finally {
        document.dispose();
        world.destroy();
      }
    }).catch((cause) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
  });
  return <div class="aspect-video overflow-hidden rounded-md bg-canvas">
    <canvas ref={canvas} width={640} height={360} role="img" aria-label={`${props.block.title} preview`} class="h-full w-full" classList={{ hidden: !!error() }} />
    <Show when={error()}><p role="alert" class="flex h-full items-center px-4 text-xs text-muted-foreground">{error()}</p></Show>
  </div>;
}

export function MotionLibrary() {
  const [adding, setAdding] = createSignal<string>();
  const [message, setMessage] = createSignal("");
  const [error, setError] = createSignal("");
  const add = async (block: MotionBlock) => {
    if (adding()) return;
    setAdding(block.id); setError(""); setMessage("");
    try {
      await insertMotionBlock(block);
      setMessage(`${block.title} added at playhead`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setAdding(undefined); }
  };
  return <section class="h-full min-h-0 overflow-y-auto" aria-label="Motion library">
    <div class="px-4 py-4">
      <h2 class="text-sm font-medium">Make it your own</h2>
      <p class="mt-1.5 text-xs leading-relaxed text-muted-foreground">Start with a composition. Edit every layer, path and keyframe.</p>
    </div>
    <Show when={message()}><p role="status" class="px-4 pb-3 text-xs text-muted-foreground">{message()}</p></Show>
    <Show when={error()}><p role="alert" class="px-4 pb-3 text-xs text-destructive">{error()}</p></Show>
    <div class="grid grid-cols-1 gap-6 px-4 pb-5 @[640px]:grid-cols-2">
      <For each={MOTION_BLOCKS}>{(block) => <article>
        <MotionPreview block={block} />
        <div class="mt-2.5 flex items-start gap-3">
          <div class="min-w-0 flex-1"><h3 class="text-xs font-medium">{block.title}</h3><p class="mt-1 text-xs leading-relaxed text-muted-foreground">{block.description}</p></div>
          <Button variant="secondary" class="shrink-0 gap-1" aria-label={`Add ${block.title}`} disabled={!!adding()} onClick={() => void add(block)}><Icon name="plus-add-small" class="size-4" />{adding() === block.id ? "Adding…" : "Add"}</Button>
        </div>
      </article>}</For>
    </div>
  </section>;
}
