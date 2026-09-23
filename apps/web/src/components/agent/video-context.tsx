import { createSignal, onCleanup } from "solid-js";
import { Computed, FrameRate, Name, Source, getActiveEntity, getEntityChildren, isScene } from "@diffusionstudio/runtime";
import { captureSceneFrames } from "@/dapi/handlers/capture";
import { editorLoadState, editorSession, requireEditorSession } from "@/dapi/session";
import { getDocumentEditor } from "@/engine/editor";
import { localMode } from "@/lib/local-mode";
import { flushProjectEdits } from "@/projects/edits";
import { createProjectFS } from "@/projects/fs";
import { TranscriptUnavailableError } from "@/utils/gen-ai";
import { Button } from "@/components/ui/button";
import { captureFullTranscript, type FullTranscriptAttachment } from "./full-transcript";

/** Coverage plus both sides of representative cuts, always on actual frames. */
export function planVideoContextFrames(durationFrames: number, boundaries: number[]): number[] {
  const last = Math.max(0, Math.ceil(durationFrames) - 1);
  const cuts = [...new Set(boundaries.map(Math.round).filter((frame) => frame > 0 && frame <= last))].sort((a, b) => a - b);
  const frames = new Set(Array.from({ length: 6 }, (_, i) => Math.round(last * i / 5)));
  const cutCount = Math.min(3, cuts.length);
  for (let i = 0; i < cutCount; i++) {
    const cut = cuts[Math.round(i * (cuts.length - 1) / Math.max(1, cutCount - 1))];
    frames.add(cut - 1);
    frames.add(cut);
  }
  for (let i = 0; i < 12 && frames.size < 12; i++) frames.add(Math.round(last * i / 11));
  return [...frames].sort((a, b) => a - b);
}

/** Saves a bounded visual overview and the full audible scene for a native Codex turn. */
export async function captureVideoContext(options: { onProgress?: (message: string) => void; signal?: AbortSignal } = {}) {
  if (!localMode) throw new Error("Video context attachments require local mode.");
  const session = requireEditorSession();
  const { world, project } = session;
  const projectDir = project.dir();
  const sourceState = editorLoadState();
  if (sourceState?.world !== world || sourceState.status !== "ready") {
    throw new Error("Wait for the scene to finish loading before attaching video context.");
  }
  const scene = getActiveEntity(world);
  const sceneId = scene?.get(Source)?.value;
  if (!scene || !isScene(scene) || !sceneId) throw new Error("Open a scene before attaching video context.");

  let edited = false;
  const stopListening = getDocumentEditor(world).onEdit(() => { edited = true; });
  const checkCurrent = () => {
    options.signal?.throwIfAborted();
    const current = editorSession();
    if (edited || editorLoadState() !== sourceState || current?.world !== world || current.project.dir() !== projectDir || getActiveEntity(world)?.get(Source)?.value !== sceneId) {
      throw new Error("The project or scene changed while preparing video context. Attach it again.");
    }
  };

  const directory = `.diffusion/video-context/${crypto.randomUUID()}`;
  const fs = createProjectFS(projectDir);
  let writing = false;
  try {
    options.onProgress?.("Saving edits…");
    await flushProjectEdits(world);
    checkCurrent();
    const frameRate = world.get(FrameRate)?.value ?? 30;
    const durationFrames = scene.get(Computed)?.duration ?? 0;
    if (!Number.isFinite(durationFrames) || durationFrames <= 0) throw new Error("The scene has no video duration to capture.");
    const sceneName = scene.get(Name)?.value || sceneId;
    const capturedAt = new Date().toISOString();
    const frameNumbers = planVideoContextFrames(durationFrames, getEntityChildren(world, scene).flatMap((child) => {
      const timing = child.get(Computed);
      return timing ? [timing.start, timing.end] : [];
    }));

    options.onProgress?.("Transcribing video…");
    let fullTranscript: FullTranscriptAttachment | undefined;
    let transcriptStatus: "available" | "no-audio" | "no-speech" = "available";
    try {
      fullTranscript = await captureFullTranscript();
    } catch (cause) {
      if (!(cause instanceof TranscriptUnavailableError)) throw cause;
      transcriptStatus = cause.reason;
    }
    checkCurrent();

    options.onProgress?.(`Capturing ${frameNumbers.length} frames…`);
    const images = await captureSceneFrames(session, sceneId, frameNumbers, { sceneTime: true });
    checkCurrent();
    if (images.length !== frameNumbers.length || images.some((image) => !image.base64)) {
      throw new Error("Video context did not capture every requested frame. Attach it again.");
    }
    const frames = [];
    for (const [index, image] of images.entries()) {
      const relativePath = `${directory}/frame-${String(index + 1).padStart(2, "0")}.png`;
      const bytes = Uint8Array.from(atob(image.base64), (character) => character.charCodeAt(0));
      writing = true;
      await fs.write(relativePath, new Blob([bytes], { type: "image/png" }));
      checkCurrent();
      frames.push({ time: frameNumbers[index] / frameRate, timecode: image.timecode, path: `${projectDir}/${relativePath}` });
    }
    const attachment = {
      projectDir, sceneId, sceneName, duration: durationFrames / frameRate, frameRate, capturedAt,
      timing: "scene-seconds" as const,
      path: `${projectDir}/${directory}/context.json`,
      fullTranscript, transcriptStatus, frames,
      sampling: "Sampled overview, up to 12 frames across the scene and representative clip boundaries. Changes between samples may be missed. Inspect exact scene times before placing an animation.",
    };
    await fs.write(`${directory}/context.json`, new Blob([JSON.stringify(attachment, null, 2)], { type: "application/json" }));
    checkCurrent();
    return attachment;
  } catch (cause) {
    if (writing) {
      await fs.remove(directory).catch((cleanup) => {
        throw new AggregateError([cause, cleanup], "Video context preparation failed and its incomplete files could not be removed.");
      });
    }
    throw cause;
  } finally {
    stopListening();
  }
}

export type VideoContextAttachment = Awaited<ReturnType<typeof captureVideoContext>>;

export function VideoContextButton(props: {
  disabled?: boolean;
  onAttach: (attachment: VideoContextAttachment) => void;
  onBusyChange?: (busy: boolean) => void;
  onError: (cause: unknown) => void;
}) {
  const [progress, setProgress] = createSignal<string>();
  let controller: AbortController | undefined;
  onCleanup(() => { controller?.abort(); props.onBusyChange?.(false); });

  const attach = async () => {
    if (progress() || props.disabled) return;
    const operation = new AbortController();
    controller = operation;
    setProgress("Preparing video…");
    props.onBusyChange?.(true);
    try {
      const attachment = await captureVideoContext({ onProgress: setProgress, signal: operation.signal });
      if (!operation.signal.aborted) props.onAttach(attachment);
    } catch (cause) {
      if (!operation.signal.aborted) props.onError(cause);
    } finally {
      if (!operation.signal.aborted) {
        setProgress(undefined);
        props.onBusyChange?.(false);
      }
    }
  };

  return <Button type="button" variant="ghost" class="text-muted-foreground" disabled={props.disabled || !!progress()} aria-busy={!!progress()} title="Attach the full transcript and sampled frames from this scene" onClick={() => void attach()}>
    {progress() || "Video context"}
  </Button>;
}
