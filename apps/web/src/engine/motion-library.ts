import { renderAuthored, type AuthoredTree } from "@diffusionstudio/reconciler";
import { Computed, FrameRate, Source, framesToSeconds, getActiveEntity, getNextName, isScene } from "@diffusionstudio/runtime";
import { editorSession, requireEditorSession } from "@/dapi/session";
import { flushProjectEdits } from "@/projects/edits";
import { getDocumentEditor } from "./editor";
import { getEditHistory } from "./history";
import { createScene, DEFAULT_SCENE_FORMAT } from "./new-scene";
import { authoredTime } from "./timing";

import { motionBlockTree, type MotionBlock } from "./motion-blocks";

/** Inserts the same ordinary authored tree used by the library preview. */
export async function insertMotionBlock(block: MotionBlock) {
  return insertMotionTree(motionBlockTree(block), { name: block.title, width: 1920, height: 1080, duration: block.duration });
}

export async function insertMotionTree(tree: AuthoredTree, composition: { name: string; width: number; height: number; duration: number }) {
  const session = requireEditorSession();
  const { world } = session;
  await flushProjectEdits(world);
  if (editorSession() !== session) throw new Error("The project changed. Add the motion block again.");
  const editor = getDocumentEditor(world);
  const history = getEditHistory(world);
  history.beginGesture();
  let inserted;
  try {
    const active = getActiveEntity(world);
    const scene = active && isScene(active) ? active : createScene(world, DEFAULT_SCENE_FORMAT);
    if (!scene) throw new Error("Open a project before adding a motion block.");
    const bounds = scene.get(Computed);
    const width = bounds?.width || 1920;
    const height = bounds?.height || 1080;
    const fps = world.get(FrameRate)?.value ?? 30;
    const start = framesToSeconds(Math.round(bounds?.localTime ?? 0), fps);
    const placed: AuthoredTree = { ...tree, props: { ...tree.props, name: getNextName(world, composition.name), width: composition.width, height: composition.height, expanded: true, start, end: start + composition.duration,
      x: (width - composition.width) / 2, y: (height - composition.height) / 2, scale: Math.min(width / composition.width, height / composition.height) } };
    [inserted] = editor.insertElement(scene, () => renderAuthored(placed));
    if (!inserted) throw new Error("This scene is locked. Unlock it before adding a motion block.");
    const end = authoredTime(world, scene, "end");
    if (end !== undefined && start + composition.duration > framesToSeconds(end, fps)) editor.editProperty(scene, "end", start + composition.duration);
    editor.select(inserted);
  } finally { history.endGesture(); }
  await flushProjectEdits(world);
  if (editorSession() !== session) throw new Error("The project changed while the motion block was saving.");
  return { source: inserted.get(Source)?.value, name: composition.name };
}
