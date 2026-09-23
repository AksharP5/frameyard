import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const requestSchema = z.object({ dir: z.string().min(1), source: z.string().min(1), scale: z.union([z.literal(1), z.literal(0.5), z.literal(0.25)]).optional() }).strict();
export type PlaybackRequest = z.infer<typeof requestSchema>;
export type PlaybackProgress = PlaybackRequest & { progress: number };
const probeSchema = z.object({
  streams: z.array(z.object({
    index: z.number().int(), codec_type: z.string(), pix_fmt: z.string().optional(),
    color_transfer: z.string().optional(), duration: z.string().optional(),
    disposition: z.object({ attached_pic: z.number().optional(), default: z.number().optional() }).optional(),
  })),
  format: z.object({ duration: z.string().optional() }),
});
const pending = new Map<string, { promise: Promise<string>; listeners: Set<(progress: number) => void> }>();
let queue = Promise.resolve();

/** Make one reusable H.264 preview at the requested resolution. Source files and project manifests stay intact. */
export async function preparePlaybackCopy(input: PlaybackRequest, onProgress: (progress: number) => void = () => {}) {
  const { dir, source, scale = 1 } = requestSchema.parse(input);
  if (!isAbsolute(dir)) throw new Error("The project folder must be an absolute path");
  const root = await realpath(dir);
  const path = resolve(root, source);
  if (!isAbsolute(source) && relative(root, path).startsWith("..")) throw new Error("Media source leaves the project");
  const original = await realpath(path);
  const info = await stat(original);
  if (!info.isFile()) throw new Error("Playback copies require a video file");
  const key = createHash("sha256").update(JSON.stringify(["h264-crf16-v2", original, info.size, info.mtimeMs, scale])).digest("hex");
  const cache = join(root, ".cache"), folder = join(cache, "playback");
  for (const path of [cache, folder]) {
    await mkdir(path, { recursive: true });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Media caches must be regular directories without symbolic links");
  }
  const output = join(folder, `${key}.mp4`);
  const existing = await lstat(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (existing) {
    if (!existing.isFile() || existing.size === 0) throw new Error("The cached playback file is invalid");
    onProgress(1);
    return output;
  }
  const active = pending.get(output);
  if (active) {
    active.listeners.add(onProgress);
    try { return await active.promise; }
    finally { active.listeners.delete(onProgress); }
  }
  const listeners = new Set([onProgress]);
  const progress = (value: number) => { for (const listener of listeners) listener(value); };
  const promise = queue.then(async () => {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", original], { maxBuffer: 2 * 1024 * 1024, timeout: 60_000 });
    const probe = probeSchema.parse(JSON.parse(stdout));
    const videos = probe.streams.filter((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
    const video = videos.find(stream => stream.disposition?.default) ?? videos[0];
    if (!video) throw new Error("No video track was found");
    // H.264 compatibility copies cannot retain alpha or HDR without a separate conversion policy.
    if (/^(yuva|gbrap|rgba|bgra|argb|abgr|ya)/.test(video.pix_fmt ?? "")) throw new Error("This video contains transparency. Import a PNG sequence to preserve its alpha channel.");
    if (["smpte2084", "arib-std-b67"].includes(video.color_transfer ?? "")) throw new Error("This HDR video needs an SDR conversion before this editor can play it.");
    const duration = Number(video.duration ?? probe.format.duration);
    const work = await mkdtemp(join(folder, ".prepare-"));
    const temporary = join(work, "copy.mp4");
    try {
      progress(0);
      await encode(original, temporary, video.index, duration, scale, progress);
      const after = await stat(original);
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error("The source changed while its playback copy was being prepared");
      await rename(temporary, output);
      progress(1);
      return output;
    } finally { await rm(work, { recursive: true, force: true }); }
  }).finally(() => pending.delete(output));
  pending.set(output, { promise, listeners });
  queue = promise.then(() => {}, () => {});
  return promise;
}

function encode(source: string, output: string, video: number, duration: number, scale: number, progress: (value: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-i", source,
      "-map", `0:${video}`, "-map", "0:a?",
      "-vf", `scale=w='max(2,trunc(iw*${scale}/2)*2)':h='max(2,trunc(ih*${scale}/2)*2)'`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
      "-pix_fmt", "yuv420p", "-threads", "4", "-fps_mode", "passthrough", "-c:a", "aac", "-b:a", "320k",
      "-movflags", "+faststart", "-progress", "pipe:1", "-stats_period", "0.5", output,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", lines = "", last = -1;
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
    child.stdout.on("data", (chunk: Buffer) => {
      lines += chunk.toString();
      const complete = lines.split("\n");
      lines = complete.pop()!;
      for (const line of complete) {
        if (!line.startsWith("out_time_us=") || !Number.isFinite(duration) || duration <= 0) continue;
        const percent = Math.min(99, Math.max(0, Math.floor(Number(line.slice(12)) / 1e6 / duration * 100)));
        if (Number.isFinite(percent) && percent !== last) { last = percent; progress(percent / 100); }
      }
    });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Could not prepare video for playback: ${stderr.trim() || `ffmpeg exited with code ${code}`}`)));
  });
}
