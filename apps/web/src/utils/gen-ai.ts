/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getAssetSpec, isAssetRef, isTransformSpec, isTransformType, parseSource } from "@diffusionstudio/jsx";
import {
  Ai, AssetId, Audio, Computed, FrameRate, GenAi, getAssetFile, getEntityTree, Hidden, Muted,
  Paint, PaintType, Source, Workarea,
} from "@diffusionstudio/runtime";
import { createEncoder } from "@diffusionstudio/encoder";
import { createCapture } from "@/engine/capture";
import { assetName, GENERATED_DIR, isPartialAsset } from "@diffusionstudio/assets";
import { defaultModelOption } from "@/components/genai/config";
import { generateRequest, transcript as transcriptSchema } from "@diffusionstudio/api-contract";
import { assert } from "@/utils";
import { uploadFile } from "@/lib/uploads";
import { jobFailure, runJob } from "@/lib/jobs";
import { hostedServiceUnavailable, localMode } from "@/lib/local-mode";
import { transcribeFile } from "@/utils/local-transcription";
import { transcriptionWindows, mergeTranscriptWindow } from "@/utils/transcription-windows";
import { toast } from "somoto";

import type { AspectRatio, AssetInput, AssetRef, AssetSpecInput, GenerateSpec, TransformType } from "@diffusionstudio/jsx";
import type { Asset, AssetLibrary, AssetType, PartialAsset, ReserveOptions, Transcript } from "@diffusionstudio/assets";
import type { AssetRef as UploadedAssetRef, Job } from "@diffusionstudio/api-contract";
import type { ExportResult } from "@diffusionstudio/encoder";
import type { Entity, World } from "koota";

/** What a failed generation is called where the user reads about it. */
const FAILURE_TITLES: Record<GenerateSpec["type"] | "transcript", string> = {
  image: "Image generation failed",
  video: "Video generation failed",
  voice: "Voice generation failed",
  audio: "Audio generation failed",
  transcript: "Caption generation failed",
};

export class TranscriptUnavailableError extends Error {
  constructor(public readonly reason: "no-audio" | "no-speech") {
    super(reason === "no-audio"
      ? "No audio found. Add an audio or video clip to the scene to generate captions."
      : "No speech detected. The audio does not appear to contain recognizable speech.");
    this.name = "TranscriptUnavailableError";
  }
}

/** What each generation is to become, for the partial that stands for it. */
const ASSET_TYPES: Record<GenerateSpec["type"], AssetType> = {
  image: "IMAGE",
  video: "VIDEO",
  voice: "AUDIO",
  audio: "AUDIO",
};

/** What each transform's failure is called where the user reads about it, and what names its result. */
const TRANSFORMS: Record<TransformType, { title: string; suffix: string }> = {
  removeBackground: { title: "Background removal failed", suffix: "Background removed" },
  upscale: { title: "Upscale failed", suffix: "Upscaled" },
  addAudio: { title: "Adding audio failed", suffix: "With audio" },
};

/**
 * A spec with defaults applied and every `AssetInput` reduced to an asset id.
 * Field order is fixed, so `JSON.stringify` of it is a stable `generationKey`.
 * A transform's key is its type and input alone: the endpoints take no model
 * and no factor, so every call over the same asset is the same call.
 */
type ResolvedGeneration =
  | { type: "image"; model: string; prompt: string; aspectRatio: AspectRatio; seed?: number; refIds: string[] }
  | { type: "video"; model: string; prompt: string; aspectRatio: AspectRatio; duration: number; audio: boolean; seed?: number; startFrameId?: string; endFrameId?: string }
  | { type: "voice"; model: string; prompt: string; voice: string; seed?: number }
  | { type: "audio"; model: string; prompt: string; duration?: number; seed?: number };
type ResolvedTransform = { type: TransformType; inputId: string };
type ResolvedSpec = ResolvedGeneration | ResolvedTransform;

const isResolvedTransform = (spec: ResolvedSpec): spec is ResolvedTransform => isTransformType(spec.type);

/** What the partial standing for a run is called and is to become, and what its failure is called. */
type RunDescription = Omit<ReserveOptions, "key" | "folder"> & { title: string };

/**
 * A failure the user has already been told of — as a toast when it happened,
 * and in the library's record from then on. It goes up the dependency graph
 * as it is: a declaration whose input failed is not a second thing gone
 * wrong.
 */
class ReportedError extends Error {}

/** Creates the project's GenAi over `library` and attaches it as the world's Ai. */
export function attachAi(world: World, library: AssetLibrary, dir?: string): EditorGenAi {
  const ai = new EditorGenAi(library, dir);
  world.set(Ai, ai);
  return ai;
}

export class EditorGenAi extends GenAi {
  private readonly library: AssetLibrary;
  /** The project's folder, so a transcription's capture compiles the sources as they are now. */
  private readonly dir?: string;

  /**
   * Declarations already resolved, keyed by ref identity — a ref consumed by
   * several elements resolves (and validates) once. A failed one is
   * forgotten, so that asking again — once its record is gone from the
   * library — asks the library again rather than this map.
   */
  private readonly memo = new Map<AssetRef, Promise<Asset>>();
  /** Runs in flight, keyed by generation key. */
  private readonly inflight = new Map<string, Promise<Asset>>();
  private transcriptionQueue: Promise<void> = Promise.resolve();

  public constructor(library: AssetLibrary, dir?: string) {
    super();
    this.library = library;
    this.dir = dir;
  }

  /** Identical concurrent declarations collapse to one request. */
  public resolve(ref: AssetRef): Promise<Asset> {
    assert(isAssetRef(ref), "Not a generate.* declaration");

    let promise = this.memo.get(ref);
    if (!promise) {
      promise = this.generateFromRef(ref);
      promise.catch(() => this.memo.delete(ref));
      this.memo.set(ref, promise);
    }
    return promise;
  }

  /**
   * Transcribes the scene's audible mix for a `<captions>` element (see the
   * runtime's asset system). Keyed by scene id + seed: the same pair is the
   * same transcript asset across sessions, and a new seed transcribes the
   * scene again.
   */
  public transcribe(world: World, scene: Entity, seed: number): Promise<Asset> {
    if (!sceneHasAudio(world, scene)) return Promise.reject(new TranscriptUnavailableError("no-audio"));
    const key = transcriptKey(scene, seed);
    return this.generated(
      key,
      () => ({ type: "TRANSCRIPT", name: `${this.nextCaptionsName()}.json`, title: FAILURE_TITLES.transcript }),
      (partial) => {
        const promise = this.transcriptionQueue.then(() => this.runTranscription(world, scene, key, partial));
        this.transcriptionQueue = promise.then(() => {}, () => {});
        return promise;
      },
    );
  }

  /**
   * The library's answer for `key`, or the run that produces one. An asset
   * the key landed as is returned; a key standing in error rejects with the
   * recorded reason — answered, not run or paid for again, and not toasted
   * again either; a run in flight is joined. Otherwise the run starts, with
   * a partial document reserved for it first (a pending one the last session
   * never finished is taken over), and ends either as the asset that
   * replaces the partial or as the partial's recorded failure.
   */
  private async generated(
    key: string,
    describe: () => RunDescription,
    run: (partial: PartialAsset) => Promise<Asset>,
  ): Promise<Asset> {
    const known = this.library.generated(key);
    if (known && !isPartialAsset(known)) {
      await this.library.settle();
      return known;
    }
    if (known?.state === "error") throw new ReportedError(known.error || "Generation failed");

    const running = this.inflight.get(key);
    if (running) return await running;

    const { title, ...partial } = describe();
    const promise = this.library.reserve({ key, folder: GENERATED_DIR, ...partial }).then(async (reserved) => {
      try {
        return await run(reserved);
      } catch (error) {
        if (error instanceof TranscriptUnavailableError) {
          await this.library.remove([reserved]);
          throw error;
        }
        const failure = reportFailure(error, title);
        this.library.fail(reserved, failure.message);
        throw failure;
      }
    });
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async generateFromRef(ref: AssetRef): Promise<Asset> {
    const spec = getAssetSpec(ref);
    const title = isTransformSpec(spec) ? TRANSFORMS[spec.type].title : FAILURE_TITLES[spec.type];

    // Inputs first: their ids are part of the key. An input that failed has
    // said so already; anything else wrong with them is said here.
    let resolved: ResolvedSpec;
    try {
      resolved = await this.resolveSpec(spec);
    } catch (error) {
      throw error instanceof ReportedError ? error : reportFailure(error, title);
    }

    // Default models changed with the API; a cached declaration still names
    // the bytes its original defaults produced, including retired models.
    if (!isResolvedTransform(resolved) && !isTransformSpec(spec)) {
      const legacy = {
        ...resolved,
        model: spec.type === "voice" ? "elevenlabs-v3" : spec.model ?? {
          image: "flux-2-turbo", video: "kling-3-pro", audio: "elevenlabs-music",
        }[spec.type],
        ...(spec.type === "voice" && spec.voice === undefined ? { voice: "CwhRBWXzGAHq8TQ4Fs17" } : {}),
      };
      if (this.library.generated(JSON.stringify(legacy))) resolved = legacy;
    }

    return this.generated(
      JSON.stringify(resolved),
      () => ({ ...this.describe(resolved), title }),
      (partial) => isResolvedTransform(resolved)
        ? this.runTransform(resolved, partial)
        : this.runGeneration(resolved, partial),
    );
  }

  /** What the partial standing for a run is called, and what it is to become. */
  private describe(spec: ResolvedSpec): { type: AssetType; name: string } {
    if (!isResolvedTransform(spec)) return { type: ASSET_TYPES[spec.type], name: provisionalName(spec.prompt) };
    const input = this.library.get(spec.inputId);
    assert(input, `Input asset ${spec.inputId} not found`);
    return { type: input.type, name: `${stem(input)} (${TRANSFORMS[spec.type].suffix})` };
  }

  private resolveInput(input: AssetInput): Promise<Asset> {
    return isAssetRef(input) ? this.resolve(input) : this.library.resolve(input);
  }

  private async resolveSpec(spec: AssetSpecInput): Promise<ResolvedSpec> {
    if (isTransformSpec(spec)) {
      const input = await this.resolveInput(spec.input);
      return { type: spec.type, inputId: input.id };
    }

    switch (spec.type) {
      case "image": {
        const refs = await Promise.all((spec.refs ?? []).map((ref) => this.resolveInput(ref)));
        return {
          type: "image",
          model: spec.model ?? defaultModelOption("IMAGE").id,
          prompt: spec.prompt,
          aspectRatio: spec.aspectRatio ?? "16:9",
          seed: spec.seed,
          refIds: refs.map((asset) => asset.id),
        };
      }
      case "video": {
        const [startFrame, endFrame] = await Promise.all([
          spec.startFrame !== undefined ? this.resolveInput(spec.startFrame) : undefined,
          spec.endFrame !== undefined ? this.resolveInput(spec.endFrame) : undefined,
        ]);
        return {
          type: "video",
          model: spec.model ?? defaultModelOption("VIDEO").id,
          prompt: spec.prompt,
          aspectRatio: spec.aspectRatio ?? "16:9",
          duration: spec.duration ?? 5,
          audio: spec.audio ?? false,
          seed: spec.seed,
          startFrameId: startFrame?.id,
          endFrameId: endFrame?.id,
        };
      }
      case "voice": {
        const model = defaultModelOption("VOICE");
        const voice = spec.voice ?? model.voices?.[0]?.value;
        assert(voice, "The voice model has no default voice");
        return {
          type: "voice",
          model: model.id,
          prompt: spec.prompt,
          voice,
          seed: spec.seed,
        };
      }
      case "audio": {
        return {
          type: "audio",
          model: spec.model ?? defaultModelOption("AUDIO").id,
          prompt: spec.prompt,
          duration: spec.duration,
          seed: spec.seed,
        };
      }
    }
  }

  /**
   * Runs a generation and stores its first result in place of `partial`. A
   * spec a model cannot take fails here rather than before the partial is
   * reserved, so the refusal is recorded like any other and not asked again.
   */
  private async runGeneration(spec: ResolvedGeneration, partial: PartialAsset): Promise<Asset> {
    assert(!localMode, hostedServiceUnavailable);
    const job = await this.requestGeneration(spec);
    assert(job.status === "succeeded", jobFailure(job));
    const file = job.assets[0];
    assert(file, "No results returned from the model");
    return this.store(file, partial.generation.key, job.id);
  }

  /** Encodes the scene's audio, transcribes it, and stores the transcript in place of `partial`. */
  private async runTranscription(world: World, scene: Entity, key: string, partial: PartialAsset): Promise<Asset> {
    const frameRate = world.get(FrameRate)?.value ?? 30;
    const duration = (scene.get(Computed)?.end ?? 0) / frameRate;
    let transcript: Transcript = [];
    let jobId: string | undefined;
    let code: string | undefined;

    for (const window of transcriptionWindows(duration, frameRate)) {
      // A fresh world releases each window's audio graph and decoders before
      // transcription starts; neither stage keeps the full scene in memory.
      const capture = await createCapture(world, scene, { mode: "offline-audio", dir: this.dir, code });
      code = capture.code;
      let result: ExportResult;
      try {
        capture.node.add(Workarea);
        capture.node.set(Workarea, {
          start: Math.round(window.from * frameRate),
          end: Math.round(window.to * frameRate),
        });
        const encoder = await createEncoder(capture.world, {
          format: "ogg",
          video: { enabled: false },
          audio: { enabled: true, codec: "opus", sampleRate: 24000, numberOfChannels: 1 },
        });
        result = await encoder.render();
      } finally {
        capture.dispose();
      }
      if (result.type === "error") throw result.error;
      assert(result.type === "success" && result.data !== undefined, "Failed to encode the scene audio");

      const uploadId = crypto.randomUUID();
      const audioFile = new File([result.data], `${uploadId}.ogg`, { type: "audio/ogg" });
      const segments = localMode
        ? (await transcribeFile(audioFile, this.dir)).segments
        : await (async () => {
          const job = await runJob({ model: "universal-3.5-pro", audio: await uploadFile(audioFile) }, () => {});
          assert(job.status === "succeeded", jobFailure(job));
          const file = job.assets[0];
          assert(file, "The transcription returned nothing");
          const response = await fetch(file.url);
          assert(response.ok, `Failed to fetch the transcript: ${response.status}`);
          jobId = job.id;
          return transcriptSchema.parse(await response.json());
        })();
      transcript = mergeTranscriptWindow(transcript, segments, window);
    }

    if (!transcript.some((segment) => segment.words.length > 0)) {
      throw new TranscriptUnavailableError("no-speech");
    }

    const blob = new Blob([JSON.stringify(transcript)], { type: "application/json" });
    const asset = await this.library.store(blob, {
      name: assetName(partial),
      folder: GENERATED_DIR,
      generation: { key },
      job: jobId,
    });

    // The new file can trigger the project watcher before the library's normal
    // debounce; persist the generation key before that reload.
    await this.library.settle();
    return asset;
  }

  /** The next free `Captions N`, counting the takes still in flight. */
  private nextCaptionsName(): string {
    let max = 0;
    for (const entry of [...this.library.list(), ...this.library.partials()]) {
      const match = assetName(entry).match(/^Captions (\d+)\.json$/);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return `Captions ${max + 1}`;
  }

  /**
   * Uploads the transform's input, runs the call, and stores the result in
   * place of `partial`. A transform over the wrong kind of asset fails here,
   * like a spec a model cannot take: recorded, and not asked again.
   */
  private async runTransform(spec: ResolvedTransform, partial: PartialAsset): Promise<Asset> {
    assert(!localMode, hostedServiceUnavailable);
    assert(spec.type !== "addAudio", "The current generation API does not support transform.addAudio. Import a soundtrack instead.");
    const asset = this.library.get(spec.inputId);
    assert(asset, `Input asset ${spec.inputId} not found`);
    checkTransformInput(spec.type, asset);
    const input = await this.uploadInput(asset.id);
    const job = await this.requestTransform(spec.type, asset, input);
    assert(job.status === "succeeded", jobFailure(job));
    const file = job.assets[0];
    assert(file, "The model returned nothing");
    return this.store(file, partial.generation.key, job.id);
  }

  private requestTransform(type: Exclude<TransformType, "addAudio">, asset: Asset, input: UploadedAssetRef): Promise<Job> {
    switch (type) {
      case "removeBackground":
        return runJob({ model: "bria-rmbg-2.0", image: input }, () => {});
      case "upscale":
        return runJob(isMoving(asset.type)
          ? { model: "bytedance-upscaler", video: input }
          : { model: "seedvr-2", image: input }, () => {});
    }
  }

  /** Downloads the job's result and keeps both the legacy cache key and job provenance. */
  private async store(file: Job["assets"][number], key: string, job: string): Promise<Asset> {
    const response = await fetch(file.url);
    assert(response.ok, `Failed to fetch the generated asset: ${response.status}`);
    const asset = await this.library.store(await response.blob(), {
      name: file.filename,
      folder: GENERATED_DIR,
      generation: { key },
      job,
    });
    await this.library.settle();
    return asset;
  }

  private async requestGeneration(spec: ResolvedGeneration): Promise<Job> {
    assert(spec.seed === undefined, "The current generation API does not support seeded generation. Remove seed to request new media.");
    let request: unknown;
    switch (spec.type) {
      case "image":
        request = {
          model: spec.model, prompt: spec.prompt, aspectRatio: spec.aspectRatio, count: 1,
          images: spec.refIds.length ? await Promise.all(spec.refIds.map((id) => this.uploadInput(id))) : undefined,
        };
        break;
      case "video": {
        assert(!spec.audio, "The current generation API does not support the audio option. Import a soundtrack instead.");
        const [startFrame, endFrame] = await Promise.all([
          spec.startFrameId ? this.uploadInput(spec.startFrameId) : undefined,
          spec.endFrameId ? this.uploadInput(spec.endFrameId) : undefined,
        ]);
        request = {
          model: spec.model, prompt: spec.prompt, aspectRatio: spec.aspectRatio,
          duration: spec.duration, startFrame, endFrame,
        };
        break;
      }
      case "voice":
        request = { model: spec.model, prompt: spec.prompt, voice: spec.voice };
        break;
      case "audio":
        request = { model: spec.model, prompt: spec.prompt, duration: spec.duration };
        break;
    }
    return runJob(generateRequest.parse(request), () => {});
  }

  private async uploadInput(assetId: string): Promise<UploadedAssetRef> {
    const asset = this.library.get(assetId);
    assert(asset, `Referenced asset ${assetId} not found`);
    return uploadFile(await getAssetFile(asset));
  }
}

/** Whether an asset type is footage, for the calls that only take footage. */
const isMoving = (type: AssetType): boolean => type === "VIDEO" || type === "SEQUENCE";

/** An asset's name without its extension: what a transform's result is named after. */
const stem = (asset: Asset): string => assetName(asset).replace(/\.[^.]+$/, "");

/** What a transform can be put over; known only once the input has resolved. */
function checkTransformInput(type: TransformType, input: Asset): void {
  switch (type) {
    case "removeBackground":
      assert(input.type === "IMAGE", "Only a picture has a background to remove");
      return;
    case "upscale":
      assert(input.type === "IMAGE" || isMoving(input.type), "Only a picture or footage can be upscaled");
      return;
    case "addAudio":
      assert(isMoving(input.type), "Only footage can be scored");
      return;
  }
}

/** How much of a prompt names the partial standing for its generation. */
const PROVISIONAL_NAME_LENGTH = 48;

/**
 * What a generation is called before its result names it: the head of its
 * prompt, cut at a word. The model's own name takes over when the bytes
 * land (see `store`).
 */
function provisionalName(prompt: string): string {
  const text = prompt.trim().replace(/\s+/g, " ").replace(/\//g, "-");
  if (text.length <= PROVISIONAL_NAME_LENGTH) return text || "Generation";
  const cut = text.lastIndexOf(" ", PROVISIONAL_NAME_LENGTH);
  return `${text.slice(0, cut > 0 ? cut : PROVISIONAL_NAME_LENGTH)}…`;
}

/**
 * Says what a generation failed with, and hands the failure on as one
 * already reported. The message is what the library records on the partial
 * and what the element carries (the runtime's `SourceError`), so the
 * sentence in the asset panel, the one on the canvas and the one in the
 * toast are the same. The toast is keyed by it: variants that failed the
 * same way are one thing gone wrong rather than four, and a render that ran
 * into the same wall does not stack up.
 */
function reportFailure(error: unknown, title: string): ReportedError {
  const message = error instanceof Error ? error.message : String(error);

  console.error(`[gen-ai] ${title}:`, error);
  toast.error(title, {
    id: `gen-ai:${title}:${message}`,
    description: message,
  });

  return new ReportedError(message);
}

/**
 * The transcript cache key: scene id + seed. The scene's durable name is the
 * id in its source stamp (`<file>:<id>`, stamped once by the compiler — the
 * same identity the project config keys by); a scene without one falls back
 * to its entity id, which only holds within the session.
 */
function transcriptKey(scene: Entity, seed: number): string {
  const source = scene.get(Source)?.value;
  const locator = source ? parseSource(source)?.locator : undefined;
  const sceneId = typeof locator === "string" ? locator : source ?? String(scene.id());
  return `transcript:${localMode ? "local-v5" : "v5"}:${sceneId}:${seed}`;
}

/**
 * Whether anything in the scene contributes to its audible mix: an unmuted,
 * unhidden audio clip, video, or video paint with its asset bound.
 */
function sceneHasAudio(world: World, scene: Entity): boolean {
  for (const entity of getEntityTree(world, scene)) {
    if (entity.has(Hidden) || entity.has(Muted) || !entity.has(AssetId)) continue;
    if (entity.has(Audio) || entity.get(Paint)?.value === PaintType.VIDEO) return true;
  }
  return false;
}
