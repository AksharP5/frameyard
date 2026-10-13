/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { generatedPath } from "@diffusionstudio/dapi";
import type { GenerationResult, TimecodedImage, ToolArgs, ToolName, ToolOutput, ToolResult } from "@diffusionstudio/dapi";

/** A file the tool wrote, kept in memory only long enough to decide whether to inline it. */
export type WrittenImage = { path: string; png: Uint8Array };

export type Presented = {
  output: unknown;
  images: WrittenImage[];
  content?: CallToolResult["content"];
  isError?: boolean;
};

/** More than this, or any image larger than INLINE_MAX_BYTES, and the caller gets paths only. */
const INLINE_MAX_IMAGES = 4;
const INLINE_MAX_BYTES = 1 << 20;

const APP_SLUG = "diffusion-studio";

function tempDir(): string {
  const dir = tmpdir();
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

export async function present(name: ToolName, args: unknown, result: unknown): Promise<Presented> {
  switch (name) {
    case "agent_tool": {
      const output = result as ToolResult<"agent_tool">;
      const content = output.contentItems.map((item): CallToolResult["content"][number] => {
        if (item.type === "inputText") return { type: "text", text: item.text };
        const image = /^data:(image\/[^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(item.imageUrl);
        if (!image) throw new Error("Editor tool returned an unsupported image URL; expected a base64 image data URL.");
        return { type: "image", mimeType: image[1], data: image[2] };
      });
      return { output, images: [], content, isError: !output.success };
    }
    case "capture":
      return presentImages(result as ToolResult<"capture">, (args as ToolArgs<"capture">).output, "capture");
    case "grab":
    case "media_grab":
      return presentImages(result as ToolResult<"media_grab">, (args as ToolArgs<"media_grab">).output, "grab");
    case "filmstrip":
    case "media_filmstrip":
      return presentPreview(result as ToolResult<"media_filmstrip">, (args as ToolArgs<"media_filmstrip">).output, "filmstrip");
    case "waveform":
    case "media_waveform":
      return presentPreview(result as ToolResult<"media_waveform">, (args as ToolArgs<"media_waveform">).output, "waveform");
    case "screenshot":
      return presentScreenshot(result as ToolResult<"screenshot">, (args as ToolArgs<"screenshot">).output);
    case "transcribe":
    case "media_transcribe":
      return presentTranscript(result as ToolResult<"media_transcribe">, (args as ToolArgs<"media_transcribe">).output);
    case "media_segment":
      return presentSegment(result as ToolResult<"media_segment">, (args as ToolArgs<"media_segment">).output);
    case "generate":
      if ((args as ToolArgs<"generate">).estimate) return { output: result, images: [] };
      return presentJob(result as GenerationResult);
    case "job":
      return presentJob(result as GenerationResult);
    case "context":
      return presentContext(result as ToolResult<"context">);
    default:
      return { output: result, images: [] };
  }
}

// Frames and contact sheets arrive in the same shape: each image is stamped
// with its timecode (`08s10f`, or `0f-08s10f` for a sheet), which is the
// filename too.
async function presentImages(images: TimecodedImage[], output: string | undefined, kind: string): Promise<Presented> {
  const dir = output ?? (await mkdtemp(join(tempDir(), `dapi-${kind}-`)));
  await mkdir(dir, { recursive: true });
  const written: WrittenImage[] = [];
  const refs: ToolOutput<"capture">["images"] = [];
  for (const { timecode, png } of images) {
    const path = join(dir, `${timecode}.png`);
    await writePrivateFile(path, png);
    written.push({ path, png });
    refs.push({ timecode, path });
  }
  return { output: { images: refs }, images: written };
}

/**
 * Where a single-file tool writes: `output` when given, a fresh name under
 * the temp dir otherwise. An `output` that names an existing directory gets
 * the fresh name inside it rather than an EISDIR from writeFile.
 */
async function singleFilePath(output: string | undefined, name: string): Promise<string> {
  if (output === undefined) return join(tempDir(), name);
  const existing = await stat(output).catch(() => null);
  if (existing?.isDirectory()) return join(output, name);
  await mkdir(dirname(output), { recursive: true });
  return output;
}

async function presentPreview(
  result: { png: Uint8Array } & Record<string, unknown>,
  output: string | undefined,
  kind: string,
): Promise<Presented> {
  const { png, ...rest } = result;
  const path = await singleFilePath(output, `dapi-${kind}-${randomUUID()}.png`);
  await writePrivateFile(path, png);
  return { output: { path, ...rest }, images: [{ path, png }] };
}

async function presentScreenshot(result: ToolResult<"screenshot">, output: string | undefined): Promise<Presented> {
  const dir = output ?? tempDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, screenshotFilename(new Date()));
  await writePrivateFile(path, result.png);
  const presented: ToolOutput<"screenshot"> = { path, width: result.width, height: result.height };
  return { output: presented, images: [{ path, png: result.png }] };
}

async function presentTranscript(transcript: ToolResult<"media_transcribe">, output: string | undefined): Promise<Presented> {
  const path = await singleFilePath(output, `dapi-transcript-${randomUUID()}.json`);
  await writePrivateFile(path, JSON.stringify(transcript, null, 2));
  const words = transcript.segments.reduce((sum, segment) => sum + segment.words.length, 0);
  const presented: ToolOutput<"media_transcribe"> = { path, segments: transcript.segments.length, words };
  return { output: presented, images: [] };
}

async function writePrivateFile(path: string, data: Uint8Array | string | ReadableStream<Uint8Array>): Promise<void> {
  const temporary = join(dirname(path), `.dapi-${randomUUID()}.tmp`);
  try {
    if (typeof data === "string" || data instanceof Uint8Array) {
      await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    } else {
      const file = await open(temporary, "wx", 0o600);
      const reader = data.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await file.writeFile(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
        await file.close();
      }
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * The picture always goes to the temp dir; `output` is where the mask goes.
 * A mask the renderer put into the project's library comes with its path; one
 * that comes as bytes is written here, to `output` or the temp dir. A track
 * still running in the background has no picture yet (see `presentContext`).
 */
async function presentSegment(result: ToolResult<"media_segment">, output: string | undefined): Promise<Presented> {
  const { png, mask, ...found } = result;
  let path = found.path;
  if (mask) {
    path = await singleFilePath(output, `dapi-mask-${randomUUID()}.mask`);
    await writePrivateFile(path, mask);
  }
  const images: WrittenImage[] = [];
  let image: string | undefined;
  if (png) {
    image = join(tempDir(), `dapi-segment-${randomUUID()}.png`);
    await writePrivateFile(image, png);
    images.push({ path: image, png });
  }
  const presented: ToolOutput<"media_segment"> = { ...found, ...(image === undefined ? {} : { image }), ...(path === undefined ? {} : { path }) };
  return { output: presented, images };
}

/** Contact sheets of background tracks already written, by track id: each is written, and shown inline, once. */
const trackSheets = new Map<string, string>();

/** A done track's contact sheet goes to the temp dir the first poll it shows up in, and arrives inline with that poll. */
async function presentContext(result: ToolResult<"context">): Promise<Presented> {
  const images: WrittenImage[] = [];
  const masks: ToolOutput<"context">["masks"] = [];
  for (const { png, ...row } of result.masks) {
    let image = trackSheets.get(row.id);
    if (png && image === undefined) {
      image = join(tempDir(), `dapi-segment-${randomUUID()}.png`);
      await writePrivateFile(image, png);
      trackSheets.set(row.id, image);
      images.push({ path: image, png });
    }
    masks.push(image === undefined ? row : { ...row, image });
  }
  return { output: { ...result, masks }, images };
}

/** Files of succeeded jobs saved to disk, by job id: the first poll that sees a job succeed saves them, the rest reuse the paths. */
const jobFiles = new Map<string, Promise<string[]>>();

/** Pictures of local jobs, by job id: each is written to the temp dir, and shown inline, the first poll it comes with. */
const jobImages = new Map<string, string>();

/**
 * A job's files bound for disk are saved once it has succeeded — downloaded
 * from their `url`, or written from the `bytes` a local model made — to
 * `saveTo` (see `generatedPath`; a file already there is written over, as the
 * other tools' outputs are) or under their own names into a directory of the
 * job's own under the temp dir, and their `url` or `bytes` is swapped for the
 * `path`. Files the renderer saved into the library arrive with their paths.
 * A local job's picture goes to the temp dir, named in `details.image`.
 */
async function presentJob({ job, saveTo, image }: GenerationResult): Promise<Presented> {
  const images: WrittenImage[] = [];
  let shown = job;
  if (image) {
    let path = jobImages.get(job.id);
    if (path === undefined) {
      path = join(tempDir(), `dapi-${job.id}.png`);
      await writePrivateFile(path, image);
      jobImages.set(job.id, path);
      images.push({ path, png: image });
    }
    shown = { ...job, details: { ...job.details, image: path } };
  }

  const pending = job.assets.filter((file) => file.url !== undefined || file.bytes !== undefined);
  if (job.status !== "succeeded" || pending.length === 0) return { output: shown, images };

  let paths = jobFiles.get(job.id);
  if (!paths) {
    const temp = join(tempDir(), `dapi-generate-${job.id}`);
    const targets = job.assets.map((file, i) =>
      saveTo === null ? join(temp, basename(file.filename)) : generatedPath(saveTo, file.filename, i, job.assets.length),
    );
    paths = saveAll(job.assets, targets);
    paths.catch(() => jobFiles.delete(job.id));
    jobFiles.set(job.id, paths);
  }
  const written = await paths;
  const assets = job.assets.map(({ url: _url, bytes: _bytes, ...file }, i) => ({ ...file, path: written[i] }));
  return { output: { ...shown, assets }, images };
}

async function saveAll(files: GenerationResult["job"]["assets"], targets: string[]): Promise<string[]> {
  for (const [i, file] of files.entries()) {
    await mkdir(dirname(targets[i]!), { recursive: true });
    await writePrivateFile(targets[i]!, file.bytes ?? (await download(file.url!, file.filename)));
  }
  return targets;
}

async function download(url: string, filename: string): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${filename} (${response.status})`);
  if (!response.body) throw new Error(`Could not download ${filename}: the response has no body.`);
  return response.body;
}

function screenshotFilename(taken: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = [taken.getFullYear(), pad(taken.getMonth() + 1), pad(taken.getDate())].join("-");
  const time = [pad(taken.getHours()), pad(taken.getMinutes()), pad(taken.getSeconds())].join("-");
  return `${APP_SLUG}_${date}_${time}-${randomUUID()}.png`;
}

/** Preserve structured output and present editor content directly; inline file previews when small. */
export function toCallToolResult({ output, images, content = [{ type: "text", text: JSON.stringify(output) }], isError }: Presented): CallToolResult {
  const inline = images.length <= INLINE_MAX_IMAGES && images.every((image) => image.png.byteLength <= INLINE_MAX_BYTES);
  if (inline) {
    for (const { png } of images) {
      content.push({ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" });
    }
  }
  return { content, structuredContent: output as Record<string, unknown>, ...(isError === undefined ? {} : { isError }) };
}

/** A failure the agent reads as a sentence, not a protocol error. */
export function toErrorResult(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: (error as Error).message }] };
}
