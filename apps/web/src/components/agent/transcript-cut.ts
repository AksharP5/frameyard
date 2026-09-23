import {
  AdjustmentLayer, Animation, Computed, Geometry, Group, Host, KeyframeTrack, Loop, Playback, Scene,
  Sequential, Source, SyncRequest, Transition, Workarea,
  getEntityChildren, getEntityTree, handOffDecoders, hasHtmlPaint, recomputeEntityTimeRange, setPlayhead,
} from "@diffusionstudio/runtime";
import { authoredElement } from "@diffusionstudio/reconciler";
import { isAssetRef, isPropValue } from "@diffusionstudio/jsx";
import { getDocumentEditor } from "@/engine/editor";
import { getEditHistory } from "@/engine/history";
import { isClipLocked } from "@/engine/clip-links";
import { authoredTime, editTime, editWorkarea, moveEntityTo, trimIn, trimOut } from "@/engine/timing";
import type { Entity, World } from "koota";

type CutOperation = { entity: Entity; start: number; end: number; kind: "remove" | "move" | "head" | "tail" | "split" };

/** Preflight the entire edit before a checkpoint or document mutation. */
export function planTranscriptCut(world: World, scene: Entity, from: number, to: number) {
  const duration = scene.get(Computed)?.duration ?? 0;
  const start = Math.max(0, Math.round(from));
  const end = Math.min(duration, Math.round(to));
  if (end <= start) throw new Error("Select words with a nonempty time range.");
  if (start === 0 && end === duration) throw new Error("Keep at least one frame in the scene.");
  if (isClipLocked(scene)) throw new Error("Unlock the scene before cutting its transcript.");
  if (scene.has(Loop) || !scene.get(Source)?.value) throw new Error("This scene cannot be cut from the transcript.");
  if (getEntityChildren(world, scene).some((child) => child.has(Animation) || child.has(Transition) || child.has(KeyframeTrack))) {
    throw new Error("Transcript cuts do not support animations on the scene itself. Move them onto individual clips first.");
  }
  const sceneProps = authoredElement(scene)?.props;
  if ((authoredTime(world, scene, "start") ?? 0) !== 0 || (authoredTime(world, scene, "sourceIn") ?? 0) !== 0 || sceneProps?.sourceOut !== undefined || sceneProps?.playbackRate && sceneProps.playbackRate !== 1 || scene.get(Computed)?.start !== 0) {
    throw new Error("Transcript cuts require a scene starting at zero, with normal playback speed and no source trim.");
  }
  const operations: CutOperation[] = [];
  const sequences: Entity[] = [];
  const visit = (entity: Entity) => {
    if (!entity.has(Geometry) && !entity.has(Group) && !entity.has(AdjustmentLayer)) return;
    const computed = entity.get(Computed);
    if (!computed || computed.end <= start) return;
    const element = authoredElement(entity);
    const descendants = getEntityTree(world, entity);
    if (isClipLocked(entity) || !entity.has(Sequential) && descendants.some(isClipLocked)) {
      throw new Error("This cut affects locked clips. Unlock them before cutting.");
    }
    if (!element || descendants.some((node) => node.has(Loop) || node.has(SyncRequest))) {
      throw new Error("Transcript cuts do not support looped or automatically synced clips. Flatten those clips first.");
    }
    if (entity.has(Sequential)) {
      if (Object.keys(element.props).some((key) => ["start", "end", "sourceIn", "sourceOut", "playbackRate"].includes(key)) || getEntityChildren(world, entity).some((child) => child.has(Animation) || child.has(Transition) || child.has(KeyframeTrack))) {
        throw new Error("Transcript cuts do not support a sequence with its own timing or animation. Move those onto individual clips first.");
      }
      sequences.push(entity);
      for (const child of getEntityChildren(world, entity)) visit(child);
      return;
    }
    const kind = computed.start >= end ? "move"
      : computed.start >= start && computed.end <= end ? "remove"
      : computed.start < start && computed.end > end ? "split"
      : computed.start < start ? "tail" : "head";
    if ((entity.has(Group) || entity.has(Scene)) && kind !== "move" && kind !== "remove") {
      throw new Error("This cut crosses a group or nested scene. Ungroup it or cut outside its boundaries.");
    }
    if (kind !== "move" && kind !== "remove" && descendants.some((node) => node.has(Animation) || node.has(Transition))) {
      throw new Error("This cut crosses a clip with a preset animation or transition. Remove that preset before cutting.");
    }
    for (const node of descendants) {
      if (node.get(Host)?.native === false || hasHtmlPaint(node)) {
        throw new Error("This cut includes HTML content that cannot be preserved. Flatten it first.");
      }
      const authored = authoredElement(node);
      if (!authored) continue;
      if (!node.get(Source)?.value || Object.values(authored.props).some((value) => value !== undefined && !isPropValue(value) && !isAssetRef(value))) {
        throw new Error("This cut includes a clip with dynamic properties that cannot be preserved. Flatten it first.");
      }
    }
    operations.push({ entity, start: computed.start, end: computed.end, kind });
  };
  for (const child of getEntityChildren(world, scene)) visit(child);
  return { scene, start, end, duration, operations, sequences };
}

export function applyTranscriptCut(world: World, plan: ReturnType<typeof planTranscriptCut>) {
  const { scene, start, end, operations } = plan;
  const removed = end - start;
  const editor = getDocumentEditor(world);
  const history = getEditHistory(world);
  const explicitEnd = authoredTime(world, scene, "end");
  const workarea = scene.get(Workarea);
  history.beginGesture();
  try {
    // Every original is copied before any trim can change a sequence's bounds.
    const copies = new Map(editor.duplicateInPlace(operations.filter((op) => op.kind === "split").map((op) => op.entity))
      .map(({ original, copy }) => [original, copy]));
    for (const operation of operations) {
      const { entity, kind } = operation;
      if (kind === "remove") editor.remove(entity);
      if (kind === "move") moveEntityTo(world, entity, operation.start - removed);
      if (kind === "tail") trimOut(world, entity, start);
      if (kind === "head") {
        trimIn(world, entity, end);
        moveEntityTo(world, entity, start);
      }
      if (kind === "split") {
        const copy = copies.get(entity);
        if (!copy) throw new Error("Could not preserve a clip's second half.");
        trimOut(world, entity, start);
        trimIn(world, copy, end);
        moveEntityTo(world, copy, start);
        handOffDecoders(world, entity, copy);
      }
    }
    for (const sequence of [...plan.sequences].reverse()) {
      if (sequence.isAlive() && getEntityChildren(world, sequence).length === 0) editor.remove(sequence);
      else if (sequence.isAlive()) recomputeEntityTimeRange(world, sequence);
    }
    recomputeEntityTimeRange(world, scene);
    if (explicitEnd !== undefined) editTime(world, scene, "end", explicitEnd - removed);
    if (workarea) {
      const shifted = (frame: number) => frame <= start ? frame : frame < end ? start : frame - removed;
      const range: [number, number] = [shifted(workarea.start), shifted(workarea.end)];
      editWorkarea(world, scene, range[1] > range[0] ? range : null);
    }
  } finally {
    history.endGesture();
  }
  scene.set(Playback, { playing: false });
  setPlayhead(world, scene, start);
}
