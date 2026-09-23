import { authoredElement, Highlight } from "@diffusionstudio/reconciler";
import { parseHighlightOptions, type PropValue } from "@diffusionstudio/jsx";
import { Computed, FrameRate, Source, framesToSeconds, getActiveEntity, getNextName, getParentEntity, isScene } from "@diffusionstudio/runtime";
import { addHighlightSchema, updateHighlightSchema, type AddHighlightInput, type UpdateHighlightInput } from "@desktop/highlight-contracts";
import { editorSession, requireEditorSession } from "@/dapi/session";
import { resolveNode } from "@/dapi/lib/nodes";
import { flushProjectEdits } from "@/projects/edits";
import { getDocumentEditor } from "./editor";
import { getEditHistory } from "./history";
import { authoredTime } from "./timing";
import type { Entity } from "koota";

/** The palette and agent write the same editable effect over the scene's existing layers. */
export async function addHighlight(input: AddHighlightInput) {
  const { sceneId, region, sceneSize, frameRate, start, end, name, ...options } = addHighlightSchema.parse(input);
  const area: [number, number, number, number] = [region.x, region.y, region.width, region.height];
  parseHighlightOptions({ ...options, region: area });
  const session = requireEditorSession();
  const { world } = session;
  await flushProjectEdits(world);
  if (editorSession() !== session) throw new Error("The highlight's project is no longer open");

  const scene = sceneId ? resolveNode(world, sceneId) : getActiveEntity(world);
  if (!scene || !isScene(scene) || !scene.get(Source)?.value) throw new Error("Select a scene before adding a highlight");
  const bounds = scene.get(Computed);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) throw new Error("The scene's frame size is not ready");
  if (sceneSize && (sceneSize.width !== bounds.width || sceneSize.height !== bounds.height)) {
    throw new Error("The scene size changed. Mark the area again before adding the highlight");
  }
  const fps = world.get(FrameRate)?.value ?? 30;
  if (frameRate !== undefined && frameRate !== fps) throw new Error("The frame rate changed. Select the time range again");
  const timing = snapTiming(start, end, fps);
  const sceneEnd = authoredTime(world, scene, "end");
  const editor = getDocumentEditor(world);
  const history = getEditHistory(world);
  history.beginGesture();
  let entity: Entity | undefined;
  try {
    [entity] = editor.insertElement(scene, () => (
      <Highlight
        name={name ?? getNextName(world, "Highlight")}
        width={bounds.width}
        height={bounds.height}
        region={area}
        {...timing}
        {...options}
      />
    ));
    if (!entity) throw new Error("The scene cannot accept a highlight");
    if (sceneEnd !== undefined && timing.end > framesToSeconds(sceneEnd, fps)) editor.editProperty(scene, "end", timing.end);
    editor.select(entity);
  } finally { history.endGesture(); }

  await flushProjectEdits(world);
  if (editorSession() !== session) throw new Error("The highlight's project is no longer open");
  const source = entity.get(Source)?.value;
  if (!source) throw new Error("The highlight no longer exists in the scene");
  return { source, sceneId: scene.get(Source)!.value, ...timing };
}

export async function updateHighlight(input: UpdateHighlightInput) {
  const { id, props: { region, ...props } } = updateHighlightSchema.parse(input);
  const session = requireEditorSession();
  const { world } = session;
  await flushProjectEdits(world);
  if (editorSession() !== session) throw new Error("The highlight's project is no longer open");
  const node = resolveNode(world, id);
  const authored = authoredElement(node);
  if (authored?.tag.toLowerCase() !== "highlight") throw new Error("Highlight controls require a highlight node");
  const scene = getParentEntity(node);
  if (!scene || !isScene(scene)) throw new Error("A highlight must be a direct child of its scene");
  const values: Record<string, PropValue | undefined> = {
    ...props,
    ...(region ? { region: [region.x, region.y, region.width, region.height] } : {}),
  };
  parseHighlightOptions({ ...authored.props, ...values });
  const fps = world.get(FrameRate)?.value ?? 30;
  const start = props.start ?? framesToSeconds(authoredTime(world, node, "start") ?? 0, fps);
  const end = props.end ?? framesToSeconds(authoredTime(world, node, "end") ?? node.get(Computed)?.end ?? 0, fps);
  const timing = snapTiming(start, end, fps);
  if (props.start !== undefined || props.end !== undefined) Object.assign(values, timing);
  const sceneEnd = authoredTime(world, scene, "end");
  const editor = getDocumentEditor(world);
  const history = getEditHistory(world);
  history.beginGesture();
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) editor.editProperty(node, key, value);
    }
    if (sceneEnd !== undefined && timing.end > framesToSeconds(sceneEnd, fps)) editor.editProperty(scene, "end", timing.end);
  } finally { history.endGesture(); }
  await flushProjectEdits(world);
  if (editorSession() !== session) throw new Error("The highlight's project is no longer open");
  return { source: node.get(Source)!.value, sceneId: scene.get(Source)!.value, ...timing };
}

function snapTiming(start: number, end: number, fps: number) {
  if (end <= start) throw new Error("Highlight end must be after start");
  const startFrame = Math.round(start * fps);
  const endFrame = Math.max(startFrame + 1, Math.round(end * fps));
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame)) throw new Error("Highlight timing exceeds the scene's frame range");
  return { start: framesToSeconds(startFrame, fps), end: framesToSeconds(endFrame, fps) };
}
