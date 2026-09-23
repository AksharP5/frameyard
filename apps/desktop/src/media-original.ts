/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const pathSchema = z.string().min(1).refine(value => !value.includes("\0"), "Paths cannot contain null bytes");
const sourceSchema = z.object({ dir: pathSchema, source: pathSchema }).strict();
const videoSchema = sourceSchema.extend({ stream: z.number().int().nonnegative().optional() });
const audioSchema = sourceSchema.extend({ stream: z.number().int().nonnegative().default(0) });
const sessionSchema = z.object({ id: z.string().uuid() }).strict();
const frameSchema = sessionSchema.extend({ frame: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
const streamSchema = z.object({
  index: z.number().int(), codec_type: z.string(), codec_name: z.string().optional(),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  sample_aspect_ratio: z.string().optional(), avg_frame_rate: z.string().optional(), r_frame_rate: z.string().optional(),
  color_transfer: z.string().optional(), duration: z.string().optional(), nb_frames: z.string().optional(),
  channels: z.number().int().positive().optional(), sample_rate: z.string().optional(),
  disposition: z.object({ attached_pic: z.number().optional(), default: z.number().optional() }).optional(),
  side_data_list: z.array(z.object({ rotation: z.number().optional() })).optional(),
  tags: z.object({ rotate: z.string().optional(), title: z.string().optional(), language: z.string().optional() }).optional(),
});
const probeSchema = z.object({ streams: z.array(streamSchema), format: z.object({ duration: z.string().optional() }).optional() });

export type OriginalMediaRequest = z.infer<typeof sourceSchema>;
export type OriginalVideoRequest = z.infer<typeof videoSchema>;
export type OriginalAudioRequest = z.input<typeof audioSchema>;
export type OriginalVideoReadRequest = z.infer<typeof frameSchema>;
export type OriginalVideoCloseRequest = z.infer<typeof sessionSchema>;
export type OriginalVideoInfo = { id: string; width: number; height: number; frameRate: number };
export type OriginalVideoFrame = { data: Uint8Array; width: number; height: number };
export type AudioStreamInfo = {
  /** Audio ordinal, used as 0:a:index by the decoder. */
  index: number; codec: string; channels: number; sampleRate: number; title?: string; language?: string;
};

type LocalMedia = Awaited<ReturnType<typeof localMedia>>;
type Decoder = {
  child: ChildProcess; output: Readable;
  closed: Promise<void>; stderr: string; error?: Error; ended: boolean; nextFrame: number;
};
type VideoSession = OriginalVideoInfo & {
  owner: number; media: LocalMedia; file: FileHandle; stream: number;
  decoder?: Decoder; last?: { frame: number; data: Uint8Array }; idle?: NodeJS.Timeout;
  used: number; closed: boolean;
};

const sessions = new Map<string, VideoSession>();
const ownerVersions = new Map<number, number>();
let disposalVersion = 0;
let opening = 0;
let reads = 0;
let decodeQueue = Promise.resolve();
let probeQueue = Promise.resolve();
const MAX_SESSIONS = 128;
const MAX_DECODERS = 4;
const MAX_PIXELS = 33_554_432;
const audioPending = new Map<string, Promise<string>>();
let audioQueue = Promise.resolve();

function sameFile(one: Stats, two: Stats): boolean {
  return one.dev === two.dev && one.ino === two.ino && one.size === two.size && one.mtimeMs === two.mtimeMs && one.ctimeMs === two.ctimeMs;
}

async function localMedia(input: OriginalMediaRequest) {
  const { dir, source } = sourceSchema.parse(input);
  if (!isAbsolute(dir)) throw new Error("The project folder must be an absolute path");
  const root = await realpath(dir);
  if (!(await stat(root)).isDirectory()) throw new Error("The project folder must be a directory");
  const target = resolve(root, source);
  const within = relative(root, target);
  if (!isAbsolute(source) && (within === ".." || within.startsWith(`..${sep}`))) throw new Error("Media source leaves the project");
  const path = await realpath(target);
  const info = await lstat(path);
  if (!info.isFile() || info.size === 0) throw new Error("Original media requires a nonempty regular file");
  return { root, path, info };
}

function probe(media: LocalMedia) {
  // Opening many clips must not start a native process for every source at once.
  const job = probeQueue.then(async () => {
    try {
      const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-show_streams", "-show_format", "-of", "json", media.path], {
        maxBuffer: 2 * 1024 * 1024, timeout: 60_000,
      });
      if (!sameFile(media.info, await stat(media.path))) throw new Error("The source changed while its streams were being inspected");
      return probeSchema.parse(JSON.parse(stdout));
    } catch (error) { throw new Error(`Could not inspect original media: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  });
  probeQueue = job.then(() => {}, () => {});
  return job;
}

function ratio(value: string | undefined): number {
  if (!value) return NaN;
  const parts = value.split(/[/:]/).map(Number);
  return parts.length === 2 ? parts[0]! / parts[1]! : Number(value);
}

export async function listMediaStreams(input: OriginalMediaRequest): Promise<AudioStreamInfo[]> {
  const media = await localMedia(input);
  const metadata = await probe(media);
  return metadata.streams.filter(stream => stream.codec_type === "audio").map((stream, index) => ({
    index, codec: stream.codec_name ?? "unknown", channels: stream.channels ?? 0,
    sampleRate: Number(stream.sample_rate) || 0,
    ...(stream.tags?.title ? { title: stream.tags.title } : {}),
    ...(stream.tags?.language ? { language: stream.tags.language } : {}),
  }));
}

/** Open original source pixels for final rendering, independent of preview proxies. */
export async function openOriginalVideo(input: OriginalVideoRequest, owner = 0): Promise<OriginalVideoInfo> {
  if (sessions.size + opening >= MAX_SESSIONS) throw new Error("Too many original video sources are open. Close unused sources before continuing.");
  const generation = disposalVersion, ownerGeneration = ownerVersions.get(owner) ?? 0;
  opening++;
  let file: FileHandle | undefined;
  try {
    const { stream, ...source } = videoSchema.parse(input);
    const media = await localMedia(source);
    const metadata = await probe(media);
    const videos = metadata.streams.filter(value => value.codec_type === "video");
    const playable = videos.filter(value => !value.disposition?.attached_pic);
    const video = stream === undefined ? playable.find(value => value.disposition?.default) ?? playable[0] : videos[stream];
    if (!video?.width || !video.height) throw new Error("No video track was found in the original source");
    if (["smpte2084", "arib-std-b67"].includes(video.color_transfer ?? "")) throw new Error("This HDR source needs an SDR conversion before this editor can render it");
    const frameRate = ratio(video.avg_frame_rate) || ratio(video.r_frame_rate);
    if (!Number.isFinite(frameRate) || frameRate <= 0 || frameRate > 1_000) throw new Error("The original video has no supported frame rate");
    const rotation = video.side_data_list?.find(side => side.rotation !== undefined)?.rotation ?? Number(video.tags?.rotate ?? 0);
    const turns = Math.round(rotation / 90);
    if (!Number.isFinite(rotation) || Math.abs(rotation - turns * 90) > 0.01) throw new Error("Original video rotation must be a multiple of 90 degrees");
    const aspect = ratio(video.sample_aspect_ratio);
    const displayWidth = Math.round(video.width * (Number.isFinite(aspect) && aspect > 0 ? aspect : 1));
    const width = Math.abs(turns % 2) ? video.height : displayWidth;
    const height = Math.abs(turns % 2) ? displayWidth : video.height;
    if (width < 1 || height < 1 || width > 16_384 || height > 16_384 || width * height > MAX_PIXELS) throw new Error("The original video exceeds the supported frame size of 33 megapixels");
    file = await open(media.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!sameFile(media.info, await file.stat())) throw new Error("The original video changed before it could be opened");
    if (generation !== disposalVersion || ownerGeneration !== (ownerVersions.get(owner) ?? 0)) throw new Error("The video renderer closed before the source finished opening");
    const id = randomUUID();
    const info = { id, width, height, frameRate };
    sessions.set(id, { ...info, owner, media, file, stream: video.index, used: Date.now(), closed: false });
    file = undefined;
    return info;
  } finally { opening--; await file?.close(); }
}

function sessionFor(id: string, owner?: number): VideoSession {
  const session = sessions.get(id);
  if (!session || session.closed || (owner !== undefined && session.owner !== owner)) throw new Error("The original video session is no longer open");
  return session;
}

/** Requests are serialized while each FFmpeg process prefetches only a bounded pipe buffer. */
export function readOriginalVideo(input: OriginalVideoReadRequest, owner?: number): Promise<OriginalVideoFrame> {
  const { id, frame } = frameSchema.parse(input);
  const session = sessionFor(id, owner);
  if (reads >= 64) return Promise.reject(new Error("Too many original video frames are waiting to decode"));
  reads++;
  const result = decodeQueue.then(() => readFrame(session, frame)).finally(() => { reads--; });
  decodeQueue = result.then(() => {}, () => {});
  return result;
}

async function readFrame(session: VideoSession, frame: number): Promise<OriginalVideoFrame> {
  if (session.closed) throw new Error("The original video session is no longer open");
  if (!sameFile(session.media.info, await session.file.stat())) throw new Error("The original video changed while it was being rendered");
  clearTimeout(session.idle);
  session.used = Date.now();
  let watchdog: NodeJS.Timeout | undefined;
  try {
    if (session.last?.frame === frame) return { data: session.last.data, width: session.width, height: session.height };
    const next = session.decoder?.nextFrame;
    if (next === undefined || frame < next || frame - next > Math.ceil(session.frameRate / 2)) await startDecoder(session, frame);
    const decoder = session.decoder!;
    watchdog = setTimeout(() => {
      decoder.error = new Error("Original video decoding timed out while reading a frame");
      decoder.child.kill("SIGKILL");
      decoder.output.destroy();
    }, 120_000);
    session.last = undefined;
    while (decoder.nextFrame < frame) {
      await readPixels(decoder, session.width * session.height * 4, false);
      decoder.nextFrame++;
    }
    const data = await readPixels(decoder, session.width * session.height * 4, true);
    decoder.nextFrame++;
    if (!sameFile(session.media.info, await session.file.stat())) throw new Error("The original video changed while it was being rendered");
    session.last = { frame, data };
    return { data, width: session.width, height: session.height };
  } catch (error) {
    await stopDecoder(session);
    throw error;
  } finally {
    clearTimeout(watchdog);
    if (session.decoder && !session.closed) session.idle = setTimeout(() => { void stopDecoder(session); }, 60_000).unref();
  }
}

async function startDecoder(session: VideoSession, frame: number): Promise<void> {
  await stopDecoder(session);
  const active = [...sessions.values()].filter(value => value.decoder).sort((a, b) => a.used - b.used);
  if (active.length >= MAX_DECODERS) await stopDecoder(active[0]!);
  // A fresh descriptor starts at byte zero even after an earlier decoder sought.
  const input = await open(session.media.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameFile(session.media.info, await input.stat())) throw new Error("The original video changed before decoding");
    if (session.closed) throw new Error("The original video session is no longer open");
    // Keep source timestamps and decode from the preceding keyframe. The FPS
    // filter uses one global sampling grid even after a VFR or backward seek;
    // trim discards earlier grid slots before pixels are converted to RGBA.
    const seek = frame / session.frameRate;
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "2", "-filter_threads", "1", "-max_alloc", "268435456",
      "-copyts", "-start_at_zero", "-noaccurate_seek", "-ss", seek.toFixed(9), "-protocol_whitelist", "fd", "-fd", "3", "-i", "fd:",
      "-map", `0:${session.stream}`, "-an", "-sn", "-dn", "-vf", `fps=${session.frameRate}:start_time=0:round=near,trim=start_frame=${frame},scale=${session.width}:${session.height},setsar=1,format=rgba`,
      "-fps_mode", "passthrough", "-c:v", "rawvideo", "-threads", "1", "-f", "rawvideo", "-",
    ], { stdio: ["ignore", "pipe", "pipe", input.fd] });
    const decoder: Decoder = { child, output: child.stdout!, closed: new Promise(resolve => child.once("close", () => resolve())), stderr: "", ended: false, nextFrame: frame };
    // Node resumes child stdout on process exit. A persistent readable listener
    // keeps it paused between frame requests, so that flush cannot discard pixels.
    child.stdout!.on("readable", () => {});
    child.stderr!.on("data", (chunk: Buffer) => { decoder.stderr = (decoder.stderr + chunk.toString()).slice(-16_000); });
    child.stdout!.on("error", error => { decoder.error = error; });
    child.once("error", error => { decoder.error = new Error(`Could not start original video decoding: ${error.message}`, { cause: error }); });
    child.once("close", code => {
      decoder.ended = true;
      if (code !== 0 && !decoder.error) decoder.error = new Error(`Original video decoding failed: ${decoder.stderr.trim() || `ffmpeg exited with code ${code}`}`);
    });
    session.decoder = decoder;
  } finally { await input.close(); }
}

async function readPixels(decoder: Decoder, length: number, keep: boolean): Promise<Uint8Array> {
  const pixels = keep ? Buffer.allocUnsafe(length) : undefined;
  let offset = 0;
  const stream = decoder.output;
  while (offset < length) {
    const chunk: Buffer | null = stream.readableLength > 0
      ? stream.read(Math.min(length - offset, stream.readableLength, 1_048_576))
      : null;
    if (chunk) {
      pixels?.set(chunk, offset);
      offset += chunk.length;
      continue;
    }
    if (stream.readableEnded || stream.destroyed || decoder.ended || decoder.error) {
      throw decoder.error ?? new Error(`The requested frame is past the end of the original video${decoder.stderr.trim() ? `: ${decoder.stderr.trim()}` : ""}`);
    }
    await new Promise<void>((resolve, reject) => {
      const ready = () => { cleanup(); resolve(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => { stream.off("readable", ready); stream.off("end", ready); stream.off("close", ready); stream.off("error", failed); };
      stream.once("readable", ready); stream.once("end", ready); stream.once("close", ready); stream.once("error", failed);
    });
  }
  return pixels ?? new Uint8Array(0);
}

async function stopDecoder(session: VideoSession): Promise<void> {
  clearTimeout(session.idle);
  const decoder = session.decoder;
  session.decoder = undefined;
  session.last = undefined;
  if (!decoder) return;
  decoder.child.kill("SIGKILL");
  decoder.output.destroy();
  decoder.child.stderr?.destroy();
  await decoder.closed;
}

export async function closeOriginalVideo(input: OriginalVideoCloseRequest, owner?: number): Promise<void> {
  const { id } = sessionSchema.parse(input);
  const session = sessions.get(id);
  if (!session) return;
  if (owner !== undefined && session.owner !== owner) throw new Error("The original video belongs to another renderer");
  sessions.delete(id);
  session.closed = true;
  await stopDecoder(session);
  await session.file.close();
}

export async function disposeOriginalVideos(owner?: number): Promise<void> {
  if (owner === undefined) disposalVersion++;
  else ownerVersions.set(owner, (ownerVersions.get(owner) ?? 0) + 1);
  await Promise.all([...sessions.values()].filter(session => owner === undefined || session.owner === owner).map(session => closeOriginalVideo({ id: session.id }, owner)));
}

async function cacheDirectory(root: string, name: "original-audio"): Promise<string> {
  const cache = join(root, ".cache"), folder = join(cache, name);
  for (const path of [cache, folder]) {
    await mkdir(path, { recursive: true });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Media caches must be regular directories without symbolic links");
  }
  return folder;
}

/** Preserve the selected source stream as PCM float audio for preview and export. */
export async function prepareOriginalAudio(input: OriginalAudioRequest): Promise<string> {
  const { stream, ...source } = audioSchema.parse(input);
  const media = await localMedia(source);
  const key = createHash("sha256").update(JSON.stringify(["pcm-f32-v2", media.path, media.info.size, media.info.mtimeMs, media.info.ctimeMs, stream])).digest("hex");
  const folder = await cacheDirectory(media.root, "original-audio");
  const output = join(folder, `${key}.wav`);
  const existing = await lstat(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size < 44) throw new Error("The cached original audio is invalid");
    return output;
  }
  const active = audioPending.get(output);
  if (active) return active;
  if (audioPending.size >= 8) throw new Error("Too many original audio streams are waiting to decode");
  const job = audioQueue.then(async () => {
    const metadata = await probe(media);
    const track = metadata.streams.filter(value => value.codec_type === "audio")[stream];
    if (!track) throw new Error(`Audio stream ${stream + 1} was not found in the original source`);
    const stage = await mkdtemp(join(folder, ".prepare-"));
    const temporary = join(stage, "audio.wav");
    try {
      await execFileAsync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-threads", "2", "-protocol_whitelist", "file", "-i", media.path,
        "-map", `0:${track.index}`, "-vn", "-sn", "-dn", "-af", "aresample=async=1:first_pts=0", "-c:a", "pcm_f32le", "-rf64", "auto", temporary,
      ], { maxBuffer: 64_000, timeout: 60 * 60 * 1_000, killSignal: "SIGKILL" });
      if (!sameFile(media.info, await stat(media.path))) throw new Error("The original source changed while its audio was being decoded");
      await rename(temporary, output);
      return output;
    } catch (error) { throw new Error(`Could not decode original audio: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    finally { await rm(stage, { recursive: true, force: true }); }
  }).finally(() => audioPending.delete(output));
  audioPending.set(output, job);
  audioQueue = job.then(() => {}, () => {});
  return job;
}
