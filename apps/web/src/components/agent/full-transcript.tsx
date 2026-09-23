import { Ai, Computed, FrameRate, Name, Source, getActiveEntity, isScene } from "@diffusionstudio/runtime";
import { isAbsoluteSource } from "@diffusionstudio/assets";
import { editorLoadState, editorSession, requireEditorSession } from "@/dapi/session";
import { getDocumentEditor } from "@/engine/editor";
import { localMode } from "@/lib/local-mode";
import { flushProjectEdits } from "@/projects/edits";

/** Stores the whole audible scene through the same local pipeline as captions. */
export async function captureFullTranscript() {
  if (!localMode) throw new Error("Full transcript attachments require local mode.");
  const { world, project } = requireEditorSession();
  const projectDir = project.dir();
  const sourceState = editorLoadState();
  if (sourceState?.world !== world || sourceState.status !== "ready") {
    throw new Error("Wait for the scene to finish loading before attaching its transcript.");
  }
  const scene = getActiveEntity(world);
  const sceneId = scene?.get(Source)?.value;
  if (!scene || !isScene(scene) || !sceneId) throw new Error("Open a scene before attaching its transcript.");
  const ai = world.get(Ai);
  if (!ai) throw new Error("The project is still loading. Try again when it is ready.");

  let edited = false;
  const stopListening = getDocumentEditor(world).onEdit(() => { edited = true; });
  const checkCurrent = () => {
    const current = editorSession();
    if (edited || editorLoadState() !== sourceState || current?.world !== world || current.project.dir() !== projectDir || getActiveEntity(world)?.get(Source)?.value !== sceneId) {
      throw new Error("The project or scene changed while preparing the transcript. Attach it again.");
    }
  };

  try {
    await flushProjectEdits(world);
    checkCurrent();
    const capturedAt = new Date().toISOString();
    const sceneName = scene.get(Name)?.value || sceneId;
    const duration = (scene.get(Computed)?.end ?? 0) / (world.get(FrameRate)?.value ?? 30);
    // A fresh take includes edits since the last attachment or caption generation.
    const asset = await ai.transcribe(world, scene, Date.now());
    checkCurrent();
    return {
      projectDir, sceneId, sceneName, duration, capturedAt,
      path: isAbsoluteSource(asset.source) ? asset.source : `${projectDir}/${asset.source}`,
      assetPath: asset.path,
      timing: "scene-seconds" as const,
    };
  } finally {
    stopListening();
  }
}

export type FullTranscriptAttachment = Awaited<ReturnType<typeof captureFullTranscript>>;
