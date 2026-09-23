import { Show, batch, createSignal } from "solid-js";
import {
  Computed, FrameRate, Hidden, Mode, Name, Playback, RenderSurface, Size, Source, WorldTransform,
  getActiveEntity, getCamera, getParentEntity, getEntityChildren, getViewMatrix, invert2D, isScene,
  multiply2D, renderSystem, setCamera, store, transformSystem,
} from "@diffusionstudio/runtime";
import type { Entity, World } from "koota";
import { annotationSchema, regionBetween, type Annotation, type Region } from "@desktop/annotation-contracts";
import { getEditorContext } from "@/dapi/handlers/context";
import { editorLoadState, editorSession, requireEditorSession } from "@/dapi/session";
import { getDocumentEditor } from "@/engine/editor";
import { Button } from "@/components/ui/button";
import { resolveNode } from "@/dapi/lib/nodes";
import { Dialog, DialogContent, DialogDescription, DialogPortal, DialogTitle } from "@/components/ui/dialog";

export async function captureAnnotationFrame(options: { sceneId?: string; exclude?: string[] } = {}) {
  const session = requireEditorSession();
  const { world } = session;
  const projectDir = session.project.dir();
  const sourceState = editorLoadState();
  const active = getActiveEntity(world);
  const scene = options.sceneId ? resolveNode(world, options.sceneId) : active;
  const sceneId = scene?.get(Source)?.value;
  const sceneSize = scene?.get(Size);
  if (!scene || !isScene(scene) || !sceneId || !sceneSize?.width || !sceneSize.height) throw new Error("Select a scene before marking an area");
  scene.set(Playback, { playing: false });
  const frameRate = world.get(FrameRate)?.value || 30;
  const frame = Math.max(0, Math.round(scene.get(Computed)?.localTime ?? 0));
  const time = frame / frameRate;
  const sceneName = scene.get(Name)?.value || sceneId;
  let edited = false;
  const stopListening = getDocumentEditor(world).onEdit(() => { edited = true; });
  const checkCurrent = () => {
    if (edited || editorLoadState() !== sourceState || editorSession()?.world !== world || session.project.dir() !== projectDir
      || !scene.isAlive() || scene.get(Source)?.value !== sceneId || getActiveEntity(world) !== active
      || Math.max(0, Math.round(scene.get(Computed)?.localTime ?? 0)) !== frame) {
      throw new Error("The scene changed while capturing the frame. Mark the area again.");
    }
  };
  try {
    const context = await getEditorContext(() => session);
    checkCurrent();
    const imageUrl = capturePreview(world, scene, options.exclude ?? []);
    checkCurrent();
    return { sceneId, sceneName, sceneSize: { ...sceneSize }, frame, time, imageUrl, context };
  } finally {
    stopListening();
  }
}

function capturePreview(world: World, scene: Entity, exclude: string[]): string {
  const surface = world.get(RenderSurface);
  if (!surface?.canvas) throw new Error("No preview frame was rendered");
  const camera = { ...getCamera(world) };
  const mode = world.get(Mode)?.value ?? "realtime";
  const hidden = new Set(exclude.map((source) => resolveNode(world, source)));
  for (let node: Entity | null = scene; node; node = getParentEntity(node)) {
    const parent = getParentEntity(node);
    if (!parent) break;
    for (const sibling of getEntityChildren(world, parent)) if (sibling !== node) hidden.add(sibling);
  }
  for (const node of hidden) if (node.has(Hidden)) hidden.delete(node);

  transformSystem(world);
  const transforms = store(world, WorldTransform);
  const id = scene.id();
  const matrix = { a: transforms.a[id], b: transforms.b[id], c: transforms.c[id], d: transforms.d[id], e: transforms.e[id], f: transforms.f[id] };
  if (Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) < 1e-12) throw new Error("The scene has no visible area to mark");
  const sceneCamera = multiply2D(invert2D(matrix), getViewMatrix(world));
  const size = scene.get(Computed)!;
  if (!(size.width > 0 && size.height > 0)) throw new Error("The scene has no visible area to mark");
  const canvas = document.createElement("canvas");
  const resolution = 720 / size.height;
  canvas.width = Math.max(1, Math.round(size.width * resolution));
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not capture the scene preview");

  // Render the live document so unsaved edits appear. Restore all temporary
  // viewport changes synchronously before the editor can draw another frame.
  return batch(() => {
    try {
      world.set(RenderSurface, { canvas, ctx, resolution });
      world.set(Mode, { value: "offline-video" });
      setCamera(world, sceneCamera);
      for (const node of hidden) node.add(Hidden);
      transformSystem(world);
      renderSystem(world);
      return canvas.toDataURL("image/png");
    } finally {
      for (const node of hidden) node.remove(Hidden);
      setCamera(world, camera);
      world.set(RenderSurface, surface);
      world.set(Mode, { value: mode });
      transformSystem(world);
    }
  });
}

type Snapshot = Awaited<ReturnType<typeof captureAnnotationFrame>>;
export type AreaAttachment = { snapshot: Snapshot; annotation: Annotation };

export function AreaAnnotation(props: {
  snapshot: Snapshot;
  initial?: Annotation;
  title?: string;
  actionLabel?: string;
  hideNote?: boolean;
  onAttach: (attachment: AreaAttachment) => void;
  onClose: () => void;
}) {
  const [region, setRegion] = createSignal<Region | undefined>(props.initial?.region);
  const [note, setNote] = createSignal(props.initial?.note ?? "");
  const [error, setError] = createSignal("");
  const [dragging, setDragging] = createSignal(false);
  let start: { x: number; y: number } | undefined;
  let preview!: HTMLImageElement;

  const point = (event: PointerEvent) => {
    const bounds = preview.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
  };

  function attach() {
    const area = region();
    if (!area || dragging()) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = preview.naturalWidth;
      canvas.height = preview.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not annotate the frame");
      ctx.drawImage(preview, 0, 0);
      ctx.strokeStyle = "#22d3ee";
      ctx.lineWidth = 3;
      ctx.strokeRect(area.x * canvas.width, area.y * canvas.height, area.width * canvas.width, area.height * canvas.height);
      const annotation = annotationSchema.parse({ ...props.snapshot, region: area, note: note().trim(), imageUrl: canvas.toDataURL("image/png") });
      props.onAttach({ snapshot: props.snapshot, annotation });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
    <DialogPortal>
      <DialogContent class="sm:max-w-4xl max-h-[94vh] overflow-y-auto gap-3">
        <DialogTitle>{props.title ?? "Mark an area"}</DialogTitle>
        <DialogDescription class="text-xs">Drag over the area you want changed. {props.snapshot.sceneName} at {props.snapshot.time.toFixed(2)}s.</DialogDescription>
        <div class="flex justify-center min-h-0">
          <div class="relative max-w-full w-fit cursor-crosshair touch-none select-none" aria-label="Frame area selection"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              start = point(event);
              setDragging(true);
              setRegion(undefined);
            }}
            onPointerMove={(event) => { if (start) setRegion(regionBetween(start, point(event))); }}
            onPointerUp={(event) => {
              if (!start) return;
              const area = regionBetween(start, point(event));
              setRegion(area.width * preview.width >= 4 && area.height * preview.height >= 4 ? area : undefined);
              start = undefined;
              setDragging(false);
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => { start = undefined; setDragging(false); setRegion(undefined); }}>
            <img ref={preview} src={props.snapshot.imageUrl} alt="Current scene frame to annotate" draggable={false} class="block max-h-[60vh] max-w-full object-contain" />
            <Show when={region()}>{(area) => <div class="absolute pointer-events-none border-2 border-cyan-400" style={{ left: `${area().x * 100}%`, top: `${area().y * 100}%`, width: `${area().width * 100}%`, height: `${area().height * 100}%` }} />}</Show>
          </div>
        </div>
        <Show when={!props.hideNote}><textarea aria-label="Area note" placeholder="Blur this out, zoom into this…" rows={2} maxLength={4000} value={note()} onInput={(event) => setNote(event.currentTarget.value)} class="resize-none bg-secondary rounded p-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-primary" /></Show>
        <Show when={error()}><p role="alert" class="text-xs text-destructive">{error()}</p></Show>
        <div class="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button disabled={!region()?.width || !region()?.height || dragging()} onClick={attach}>{props.actionLabel ?? "Attach area"}</Button>
        </div>
      </DialogContent>
    </DialogPortal>
  </Dialog>;
}
