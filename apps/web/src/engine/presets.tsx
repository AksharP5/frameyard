import { Preset, authoredElement } from "@diffusionstudio/reconciler";
import { getPresetDefinition, parsePresetOptions } from "@diffusionstudio/jsx";
import { Computed, FrameRate, Source, framesToSeconds, getActiveEntity, getNextName, getParentEntity, isScene } from "@diffusionstudio/runtime";
import { addPresetSchema, updatePresetSchema, type AddPresetInput, type UpdatePresetInput } from "@desktop/preset-contracts";
import { editorSession, requireEditorSession } from "@/dapi/session";
import { resolveNode } from "@/dapi/lib/nodes";
import { flushProjectEdits } from "@/projects/edits";
import { getDocumentEditor } from "./editor";
import { getEditHistory } from "./history";
import { authoredTime } from "./timing";
import type { Entity } from "koota";

export async function addPreset(input: AddPresetInput) {
  const { sceneId, sceneSize, frameRate, start, end, name, ...options } = addPresetSchema.parse(input);
  const parsed = parsePresetOptions(options);
  const definition = getPresetDefinition(parsed.preset);
  const session = requireEditorSession();
  const { world } = session;
  await flushProjectEdits(world);
  if (editorSession() !== session) throw new Error("The effect's project is no longer open");
  const scene = sceneId ? resolveNode(world, sceneId) : getActiveEntity(world);
  if (!scene || !isScene(scene) || !scene.get(Source)?.value) throw new Error("Select a scene before adding an effect");
  const bounds = scene.get(Computed);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) throw new Error("The scene's frame size is not ready");
  if (sceneSize && (sceneSize.width !== bounds.width || sceneSize.height !== bounds.height)) throw new Error("The scene size changed. Choose the area again");
  const fps = world.get(FrameRate)?.value ?? 30;
  if (frameRate !== undefined && frameRate !== fps) throw new Error("The frame rate changed. Select the time range again");
  const timing = snapTiming(start, end, fps);
  const sceneEnd = authoredTime(world, scene, "end");
  const editor = getDocumentEditor(world);
  const history = getEditHistory(world);
  const common = { name: name ?? getNextName(world, definition.title), width: bounds.width, height: bounds.height, ...timing };
  history.beginGesture();
  let entity: Entity | undefined;
  try {
    [entity] = editor.insertElement(scene, () => <Preset {...common} preset={parsed.preset} settings={parsed.settings} />);
    if (!entity) throw new Error("The scene cannot accept this effect");
    if (sceneEnd !== undefined && timing.end > framesToSeconds(sceneEnd, fps)) editor.editProperty(scene, "end", timing.end);
    editor.select(entity);
  } finally { history.endGesture(); }
  await flushProjectEdits(world);
  if (editorSession() !== session) throw new Error("The effect's project is no longer open");
  const source = entity.get(Source)?.value;
  if (!source) throw new Error("The effect no longer exists in the scene");
  return { source, preset: parsed.preset, sceneId: scene.get(Source)!.value, ...timing };
}

export async function updatePreset(input: UpdatePresetInput) {
  const { id, settings, start: nextStart, end: nextEnd, name } = updatePresetSchema.parse(input);
  const session = requireEditorSession();
  const { world } = session;
  await flushProjectEdits(world);
  if (editorSession() !== session) throw new Error("The effect's project is no longer open");
  const node = resolveNode(world, id);
  const authored = authoredElement(node);
  if (authored?.tag.toLowerCase() !== "preset") throw new Error("Preset controls require an effect from the Effects library");
  const scene = getParentEntity(node);
  if (!scene || !isScene(scene)) throw new Error("An effect must be a direct child of its scene");
  const current = parsePresetOptions(authored.props);
  const parsed = parsePresetOptions({ preset: current.preset, settings: { ...current.settings, ...settings } });
  const fps = world.get(FrameRate)?.value ?? 30;
  const start = nextStart ?? framesToSeconds(authoredTime(world, node, "start") ?? 0, fps);
  const end = nextEnd ?? framesToSeconds(authoredTime(world, node, "end") ?? node.get(Computed)?.end ?? 0, fps);
  const timing = snapTiming(start, end, fps);
  const sceneEnd = authoredTime(world, scene, "end");
  const editor = getDocumentEditor(world);
  const history = getEditHistory(world);
  history.beginGesture();
  try {
    if (settings) editor.editProperty(node, "settings", parsed.settings);
    if (nextStart !== undefined || nextEnd !== undefined) {
      editor.editProperty(node, "start", timing.start);
      editor.editProperty(node, "end", timing.end);
    }
    if (name !== undefined) editor.editProperty(node, "name", name);
    if (sceneEnd !== undefined && timing.end > framesToSeconds(sceneEnd, fps)) editor.editProperty(scene, "end", timing.end);
  } finally { history.endGesture(); }
  await flushProjectEdits(world);
  if (editorSession() !== session) throw new Error("The effect's project is no longer open");
  return { source: node.get(Source)!.value, preset: parsed.preset, sceneId: scene.get(Source)!.value, ...timing };
}

function snapTiming(start: number, end: number, fps: number) {
  if (end <= start) throw new Error("Effect end must be after start");
  const startFrame = Math.round(start * fps);
  const endFrame = Math.max(startFrame + 1, Math.round(end * fps));
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame)) throw new Error("Effect timing exceeds the scene's frame range");
  return { start: framesToSeconds(startFrame, fps), end: framesToSeconds(endFrame, fps) };
}
