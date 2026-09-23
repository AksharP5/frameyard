import { PRESET_CATALOG, getPresetDefinition, parsePresetOptions } from "@diffusionstudio/jsx";
import { Library, Source, getActiveEntity, Computed, FrameRate, isScene } from "@diffusionstudio/runtime";
import { authoredElement } from "@diffusionstudio/reconciler";
import { mainBridge } from "@/lib/ipc";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { editorToolSchema } from "@desktop/editor-agent-contracts";
import { highlightOptionsSchema } from "@desktop/highlight-contracts";
import { editorSession, requireEditorSession } from "./session";
import { getEditorContext } from "./handlers/context";
import { captureSceneFrames } from "./handlers/capture";
import { resolveElement, resolveNode } from "./lib/nodes";
import { insertNativeTree, nativeElementTree, updateNativeElement } from "./native-authoring";
import { getDocumentEditor } from "@/engine/editor";
import { getEditHistory } from "@/engine/history";
import { insertAsset } from "@/engine/insert-asset";
import { addPreset, updatePreset } from "@/engine/presets";
import { addHighlight, updateHighlight } from "@/engine/highlight";
import { flushProjectEdits } from "@/projects/edits";
import type { CodexToolResult } from "@desktop/codex-contracts";

export async function addAgentAsset(path: string, start?: number, fit?: "contain") {
  const { world } = requireEditorSession();
  const library = world.get(Library);
  if (!library) throw new Error("Asset library is not ready");
  await library.load();
  if (editorSession()?.world !== world) throw new Error("The agent's project is no longer open");
  const asset = library.list().find((entry) => entry.path === path);
  if (!asset) throw new Error(`Asset is not in this project: ${path}`);
  const scene = getActiveEntity(world);
  if (!scene || !isScene(scene)) throw new Error("Select a scene before inserting an asset");
  const startTime = start ?? scene.get(Computed)?.localTimeInSeconds ?? 0;
  const sceneEnd = authoredElement(scene)?.props.end;
  const fps = world.get(FrameRate)?.value ?? 30;
  const history = getEditHistory(world);
  history.beginGesture();
  let source: string | undefined;
  try {
    const entity = insertAsset(world, asset, { parent: scene, start: startTime, fit });
    if (!entity) throw new Error("The scene cannot accept an asset");
    source = entity.get(Source)?.value;
    if (typeof sceneEnd === "number" && "duration" in asset) {
      const end = Math.ceil((startTime + asset.duration) * fps) / fps;
      if (Number.isFinite(end) && end > sceneEnd) getDocumentEditor(world).editProperty(scene, "end", end);
    }
  } finally { history.endGesture(); }
  await flushProjectEdits(world);
  return { source, path: asset.path };
}

export function registerAgentTools() {
  return mainBridge.handle(MAIN_CHANNELS.EDITOR_TOOL, async (request) => {
    let result: CodexToolResult;
    try {
      const session = requireEditorSession();
      if (session.project.dir() !== request.dir) throw new Error("The agent's project is no longer open");
      const tool = editorToolSchema.parse(request);
      const { world } = session;
      let data: unknown;
      if (tool.name === "editor_capture") {
        await flushProjectEdits(world);
        if (editorSession()?.world !== world) throw new Error("The agent's project is no longer open");
        const active = tool.args.sceneId ? resolveNode(world, tool.args.sceneId) : getActiveEntity(world);
        const id = active?.get(Source)?.value;
        if (!id || !isScene(active)) throw new Error("Select a scene to capture");
        const fps = world.get(FrameRate)?.value ?? 30;
        const playheadFrame = tool.args.time === undefined ? active.get(Computed)?.localTime ?? 0 : Math.round(tool.args.time * fps);
        const end = active.get(Computed)?.end ?? 0;
        if (tool.args.time !== undefined && playheadFrame >= end) throw new Error("Capture time must be within the scene duration");
        const [frame] = await captureSceneFrames(session, id, [playheadFrame], { sceneTime: true });
        if (!frame) throw new Error("No preview frame was rendered");
        result = { success: true, contentItems: [{ type: "inputImage", imageUrl: `data:image/png;base64,${frame.base64}` }] };
      } else {
        if (tool.name === "editor_add") {
          await flushProjectEdits(world);
          if (editorSession() !== session) throw new Error("The agent's project is no longer open");
          const parent = tool.args.parentId ? resolveElement(world, tool.args.parentId) : getActiveEntity(world);
          if (!parent) throw new Error("Select a scene or supply the parent source ID");
          const history = getEditHistory(world);
          history.beginGesture();
          let inserted;
          try {
            inserted = insertNativeTree(world, parent, tool.args.tree);
            getDocumentEditor(world).select(inserted);
          } finally { history.endGesture(); }
          await flushProjectEdits(world);
          if (editorSession() !== session) throw new Error("The agent's project is no longer open");
          data = { source: inserted.get(Source)?.value, nodes: nativeElementTree(world, inserted) };
        }
        if (tool.name === "editor_update") {
          const node = resolveElement(world, tool.args.id);
          const props = tool.args.props ?? {};
          if (authoredElement(node)?.tag.toLowerCase() === "highlight") {
            if (tool.args.text !== undefined) throw new Error("Highlights do not have text content");
            data = await updateHighlight({ id: tool.args.id, props });
          } else if (authoredElement(node)?.tag.toLowerCase() === "preset") {
            if (tool.args.text !== undefined) throw new Error("Effects do not have text content");
            const allowed = new Set(["name", "start", "end"]);
            if (Object.keys(props).some((key) => !allowed.has(key))) throw new Error("Use editor_update_preset to edit this effect's settings");
            data = await updatePreset({ id: tool.args.id, name: props.name, start: props.start, end: props.end });
          } else {
            const { region, ...values } = props;
            if (region || Object.keys(highlightOptionsSchema.shape).some((key) => key !== "blur" && key in values)) {
              throw new Error("Highlight controls require a highlight node");
            }
            const history = getEditHistory(world);
            history.beginGesture();
            try {
              updateNativeElement(world, node, values, tool.args.text);
            } finally { history.endGesture(); }
            await flushProjectEdits(world);
          }
        }
        if (tool.name === "editor_effects") {
          if (tool.args.id) {
            const definition = getPresetDefinition(tool.args.id);
            const { settings } = parsePresetOptions({ preset: definition.id });
            data = { ...definition, settings: Object.fromEntries(definition.controls.map((key) => [key, settings[key]])) };
          } else {
            const words = tool.args.query?.toLowerCase().trim().split(/\s+/).filter(Boolean) ?? [];
            data = PRESET_CATALOG.filter((entry) => {
              const text = `${entry.id} ${entry.title} ${entry.category} ${entry.collection} ${entry.description}`.toLowerCase();
              return words.every((word) => text.includes(word));
            })
              .map(({ id, title, category, collection, description }) => ({ id, title, category, collection, description }));
          }
        }
        if (tool.name === "editor_add_preset") data = await addPreset(tool.args);
        if (tool.name === "editor_update_preset") data = await updatePreset(tool.args);
        if (tool.name === "editor_add_highlight") {
          data = await addHighlight(tool.args);
        }
        if (tool.name === "editor_insert_asset") {
          data = await addAgentAsset(tool.args.path, tool.args.start, tool.args.fit);
        }
        data ??= await getEditorContext(() => session);
        result = { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(data) }] };
      }
    } catch (error) {
      result = { success: false, contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }] };
    }
    await mainBridge.call(MAIN_CHANNELS.EDITOR_TOOL_RESULT, { id: request.id, result });
  });
}
