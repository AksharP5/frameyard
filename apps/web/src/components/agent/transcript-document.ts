import { AssetId, Caption, Computed, FrameRate, Library, Name, Source, getEntityChildren, getEntityTree, getParentEntity, getSceneAncestor } from "@diffusionstudio/runtime";
import { authoredElement } from "@diffusionstudio/reconciler";
import { SOURCE_ATTR } from "@diffusionstudio/jsx";
import { isAbsoluteSource } from "@diffusionstudio/assets";
import { parseTranscript } from "./transcript-data";
import { authoredTime } from "@/engine/timing";
import type { Asset, AssetLibrary, Transcript } from "@diffusionstudio/assets";
import type { Entity, World } from "koota";
import type { FullTranscriptAttachment } from "./full-transcript";

const viewProps = new Set([SOURCE_ATTR, "selected", "active", "expanded", "workarea", "name", "camera", "clipHeight", "timeline", "error"]);

/** Caption spelling and editor selection do not change the speech being transcribed. */
export function transcriptSceneSignature(world: World, scene: Entity): string {
  const tree = (entity: Entity): unknown => {
    if (entity.has(Caption)) return undefined;
    const element = authoredElement(entity);
    if (!element) return undefined;
    return {
      tag: element.tag,
      // Undo writes false for a removed attribute; a fresh mount omits it.
      props: Object.fromEntries(Object.entries(element.props).filter(([key, value]) => !viewProps.has(key) && value !== false).sort(([a], [b]) => a.localeCompare(b))),
      text: element.text,
      asset: entity.get(AssetId)?.value,
      children: getEntityChildren(world, entity).map(tree).filter((node) => node !== undefined),
    };
  };
  return JSON.stringify([scene.get(Source)?.value, world.get(FrameRate)?.value, tree(scene)]);
}

export async function transcriptCacheKey(signature: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signature));
  return `transcript-panel:v1:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function readTranscriptAsset(asset: Asset) {
  return parseTranscript(JSON.parse(await (await asset.handle.getFile()).text()));
}

export function sceneTranscriptCaptions(world: World, scene: Entity) {
  return getEntityTree(world, scene).filter((entity) => entity.has(Caption) && getSceneAncestor(entity) === scene);
}

/** A full-scene transcript cannot replace a separately timed automatic caption mix. */
export function usesSceneTranscriptTiming(world: World, scene: Entity, caption: Entity) {
  const props = authoredElement(caption)?.props;
  return getParentEntity(caption) === scene
    && (authoredTime(world, caption, "start") ?? 0) === 0
    && (authoredTime(world, caption, "sourceIn") ?? 0) === 0
    && authoredTime(world, caption, "end") === undefined
    && authoredTime(world, caption, "sourceOut") === undefined
    && (!props?.playbackRate || props.playbackRate === 1);
}

export function cachedTranscript(world: World, scene: Entity, key: string) {
  const library = world.get(Library);
  // Undo can restore an earlier corrected caption source. Its revision wins.
  const linked = sceneTranscriptCaptions(world, scene)
    .map((entity) => {
      const source = authoredElement(entity)?.props.src;
      return typeof source === "string"
        ? library?.get(source) ?? library?.bySource(source)
        : library?.get(entity.get(AssetId)?.value ?? "");
    })
    .find((asset) => asset?.generation?.key === key);
  return linked ?? library?.list().find((asset) => asset.type === "TRANSCRIPT" && asset.generation?.key === key);
}

export async function saveTranscriptAsset(library: AssetLibrary, transcript: Transcript, key: string) {
  const asset = await library.store(new Blob([JSON.stringify(transcript)], { type: "application/json" }), {
    folder: "transcripts", name: `transcript-${Date.now()}.json`, generation: { key },
  });
  if (asset.generation?.key !== key) library.update(asset, { generation: { key } });
  await library.settle();
  return asset;
}

export function transcriptAttachment(world: World, scene: Entity, projectDir: string, asset: Asset): FullTranscriptAttachment {
  return {
    projectDir,
    sceneId: scene.get(Source)!.value,
    sceneName: scene.get(Name)?.value || scene.get(Source)!.value,
    duration: (scene.get(Computed)?.end ?? 0) / (world.get(FrameRate)?.value ?? 30),
    capturedAt: asset.createdAt,
    path: isAbsoluteSource(asset.source) ? asset.source : `${projectDir}/${asset.source}`,
    assetPath: asset.path,
    timing: "scene-seconds",
  };
}
