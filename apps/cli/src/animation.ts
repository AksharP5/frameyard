/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SEQUENCE_METADATA_FILE, parseSequenceMetadata } from "@diffusionstudio/assets/sequence";
import { capturedAnimationToJsx } from "./editable-animation.ts";
import { manimEditableCapture } from "./manim-editable-capture.ts";
import { hyperframesEditableCapture } from "./hyperframes-editable-capture.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function optionalStat(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
}

function inside(root: string, path: string) {
  const value = relative(root, path);
  return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function rejectSymlinks(root: string, path: string, name: string) {
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await optionalStat(current))?.isSymbolicLink()) throw new Error(`${name} cannot traverse symbolic links: ${current}`);
  }
}

async function projectPath(root: string, value: unknown, name: string): Promise<string> {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || isAbsolute(value)) {
    throw new Error(`${name} must be a relative path inside the project.`);
  }
  const path = resolve(root, value);
  if (!inside(root, path)) throw new Error(`${name} must stay inside the project.`);
  await rejectSymlinks(root, path, name);
  return path;
}

async function animationRegistry(project: string) {
  const root = await realpath(resolve(project));
  const pkg: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (!isRecord(pkg)) throw new Error("Project package.json must be an object.");
  const animations = isRecord(pkg.diffusion) ? pkg.diffusion.animations : undefined;
  if (animations !== undefined && !isRecord(animations)) throw new Error("diffusion.animations must be an object.");
  return { root, animations: animations ?? {} };
}

/** Incomplete owned frames can be replaced; unrelated files and links cannot. */
async function ownedFrames(path: string) {
  const frames: { name: string; prefix: string; digits: string; number: number }[] = [];
  let prefix: string | undefined;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error("Animation sequence must contain only matching numbered PNG frames and its sequence metadata, without symbolic links.");
    if (entry.name === SEQUENCE_METADATA_FILE) continue;
    const match = /^(.*?)(\d+)\.png$/.exec(entry.name);
    if (!match || (prefix !== undefined && prefix !== match[1])) {
      throw new Error("Animation sequence must contain only matching numbered PNG frames and its sequence metadata.");
    }
    prefix = match[1];
    frames.push({ name: entry.name, prefix, digits: match[2], number: Number(match[2]) });
  }
  return frames.sort((a, b) => a.number - b.number);
}

async function sequenceInfo(path: string) {
  const frames = await ownedFrames(path);
  if (frames.length < 2) throw new Error("Animation sequence must contain two or more numbered PNG frames.");
  const first = frames[0];
  const padding = first.digits.startsWith("0") ? first.digits.length : 0;
  for (const [index, frame] of frames.entries()) {
    if (!Number.isSafeInteger(frame.number) || frame.number !== first.number + index || frame.digits !== String(frame.number).padStart(padding, "0")) {
      throw new Error("Animation sequence frame numbers must be contiguous and consistently padded.");
    }
  }
  const metadata = await readFile(join(path, SEQUENCE_METADATA_FILE), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  const { frameRate } = metadata === undefined ? { frameRate: 30 } : parseSequenceMetadata(JSON.parse(metadata));
  const pattern = join(path.replaceAll("%", "%%"), `${first.prefix.replaceAll("%", "%%")}%${padding ? `0${padding}` : ""}d.png`);
  return { frames, frameRate, start: first.number, pattern };
}

async function validateFrames(path: string, signal?: AbortSignal) {
  const sequence = await sequenceInfo(path);
  let width = 0, height = 0;
  for (const [index, frame] of sequence.frames.entries()) {
    signal?.throwIfAborted();
    const handle = await open(join(path, frame.name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.size) throw new Error("Animation sequence contains an empty PNG frame.");
      const header = Buffer.alloc(33), ending = Buffer.alloc(12);
      await handle.read(header, 0, header.length, 0);
      if (info.size >= 45) await handle.read(ending, 0, ending.length, info.size - ending.length);
      if (info.size < 45 || !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || header.readUInt32BE(8) !== 13 || header.toString("ascii", 12, 16) !== "IHDR" || ending.readUInt32BE(0) !== 0 || ending.toString("ascii", 4, 8) !== "IEND") {
        throw new Error(`Animation sequence contains an invalid PNG frame: ${frame.name}`);
      }
      const nextWidth = header.readUInt32BE(16), nextHeight = header.readUInt32BE(20);
      if (!nextWidth || !nextHeight || (index > 0 && (width !== nextWidth || height !== nextHeight))) {
        throw new Error("Animation sequence frames must have matching, nonzero dimensions.");
      }
      width = nextWidth; height = nextHeight;
    } finally { await handle.close(); }
  }
  return sequence;
}

async function readAnimation(id: string, root: string, config: unknown) {
  if (!isRecord(config)) throw new Error(`Unknown animation: ${id}`);
  if (config.engine !== "manim" && config.engine !== "hyperframes") throw new Error(`Animation ${id} engine must be manim or hyperframes.`);
  if (config.transparent !== undefined && typeof config.transparent !== "boolean") throw new Error("Animation transparent must be a boolean.");
  const transparent = config.transparent === true;
  const frameRate = config.frameRate === undefined ? undefined : parseSequenceMetadata({ frameRate: config.frameRate }).frameRate;
  const source = await projectPath(root, config.source, "source");
  if (!(await stat(source)).isDirectory()) throw new Error("Animation source must be a directory.");
  const output = await projectPath(root, config.output, "output");
  if (extname(output) !== (transparent ? ".frames" : ".mp4")) {
    throw new Error(transparent ? "Transparent animation output must end in .frames." : "Animation output must end in .mp4.");
  }
  if (inside(source, output)) throw new Error("Animation output must be outside its source directory, such as assets/diagram.mp4 or assets/diagram.frames.");
  const existing = await optionalStat(output);
  if (existing) {
    if (transparent) {
      if (!existing.isDirectory()) throw new Error("Transparent animation output must be a frame directory.");
      await ownedFrames(output);
    } else if (!existing.isFile()) throw new Error("Animation output must be a regular file.");
  }

  if (config.engine === "hyperframes") {
    const entry = await projectPath(source, config.entry ?? "index.html", "entry");
    if (extname(entry) !== ".html" || !(await stat(entry)).isFile()) throw new Error("HyperFrames entry must name an HTML file inside source.");
    return { engine: config.engine, source, output, transparent, frameRate, entry: config.entry === undefined ? undefined : relative(source, entry) } as const;
  }
  const entry = await projectPath(source, config.entry, "entry");
  if (extname(entry) !== ".py" || !(await stat(entry)).isFile()) throw new Error("Manim entry must name a Python file inside source.");
  if (typeof config.scene !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.scene)) throw new Error("Manim scene must be a Python class name, such as Diagram.");
  return { engine: config.engine, source, output, transparent, frameRate: frameRate ?? 30, entry, scene: config.scene } as const;
}

/** One broken preview or registration should not hide the other animations. */
export async function listAnimations(project: string, engine?: "manim" | "hyperframes") {
  const { root, animations } = await animationRegistry(project);
  return Promise.all(Object.entries(animations).filter(([, config]) => !engine || (isRecord(config) && config.engine === engine)).map(async ([id, config]) => {
    try {
      const animation = await readAnimation(id, root, config);
      const path = relative(join(root, "assets"), animation.output);
      const item = { id, ...animation, libraryPath: inside(join(root, "assets"), animation.output) ? path : null, previewError: undefined };
      const file = await optionalStat(animation.output);
      if (!file) return { ...item, renderedAt: null };
      try {
        if (animation.transparent) {
          const sequence = await sequenceInfo(animation.output);
          return { ...item, frameRate: sequence.frameRate, renderedAt: file.mtimeMs };
        }
        if (!file.size) throw new Error("Animation preview is empty. Render it again.");
        return { ...item, renderedAt: file.mtimeMs };
      } catch (error) {
        return { ...item, renderedAt: null, previewError: error instanceof Error ? error.message : String(error) };
      }
    } catch (error) {
      return { id, error: error instanceof Error ? error.message : String(error) };
    }
  }));
}

type Operation = { root: string; project: string; id: string; controller: AbortController; paths: string[]; cancellable: boolean; signal?: AbortSignal; abort?: () => void; done: Promise<void>; finish: () => void };
const operations = new Set<Operation>();
let shuttingDown = false;

function beginOperation(project: string, id: string, signal?: AbortSignal): Operation {
  if (shuttingDown) throw new Error("The editor is shutting down. New animation jobs cannot start.");
  signal?.throwIfAborted();
  const root = resolve(project);
  if ([...operations].some(value => value.id === id && (value.root === root || value.project === root))) throw new Error(`Animation ${id} is already rendering, exporting, or converting.`);
  const controller = new AbortController();
  const completion = Promise.withResolvers<void>();
  const operation: Operation = { root, project: root, id, controller, paths: [], cancellable: true, signal, done: completion.promise, finish: completion.resolve };
  const abort = () => { if (operation.cancellable) controller.abort(signal?.reason ?? new Error("Animation cancelled.")); };
  operation.abort = abort;
  signal?.addEventListener("abort", abort, { once: true });
  operations.add(operation);
  return operation;
}

function endOperation(operation: Operation) {
  if (operation.abort) operation.signal?.removeEventListener("abort", operation.abort);
  operations.delete(operation);
  operation.finish();
}

/** Normal application exit waits until render processes and staging files are released. */
export async function shutdownAnimations(): Promise<void> {
  shuttingDown = true;
  const active = [...operations];
  for (const operation of active) {
    if (operation.cancellable) operation.controller.abort(new Error("Animation cancelled because the editor is shutting down."));
  }
  await Promise.all(active.map(operation => operation.done));
}

function lockOutputs(operation: Operation, root: string, paths: string[]) {
  operation.controller.signal.throwIfAborted();
  if ([...operations].some(value => value !== operation && (paths.some(path => value.paths.includes(path)) || (value.root === root && value.id === operation.id)))) {
    throw new Error(`Animation ${operation.id} is already rendering, exporting, or converting to this output.`);
  }
  operation.root = root;
  operation.paths = paths;
}

export async function cancelAnimation(id: string, project: string): Promise<boolean> {
  const requested = resolve(project);
  let operation = [...operations].find(value => value.id === id && (value.project === requested || value.root === requested));
  if (!operation) {
    const root = await realpath(requested);
    operation = [...operations].find(value => value.id === id && value.root === root);
  }
  if (!operation?.cancellable) return false;
  operation.controller.abort(new Error("Animation cancelled."));
  return true;
}

function runRenderer(executable: string, args: string[], cwd: string, signal: AbortSignal, capture = false): Promise<string> {
  signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = { ...process.env, DO_NOT_TRACK: "1", HYPERFRAMES_NO_TELEMETRY: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(executable, args, { cwd, env, detached: grouped, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "", output = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (force: boolean) => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
        else child.kill(force ? "SIGKILL" : "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") reject(error);
      }
    };
    const abort = () => {
      kill(false);
      killTimer = setTimeout(() => kill(true), 1500);
      killTimer.unref();
    };
    const cleanup = () => { signal.removeEventListener("abort", abort); clearTimeout(killTimer); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (capture) output = (output + chunk).slice(-64_000);
      else process.stderr.write(chunk);
      tail = (tail + chunk).slice(-4000);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      process.stderr.write(chunk);
      tail = (tail + chunk).slice(-4000);
    });
    child.once("error", (error) => { cleanup(); reject(new Error(`Cannot start ${executable}: ${error.message}`)); });
    child.once("close", (code, exitSignal) => {
      if (signal.aborted) kill(true);
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else if (code === 0) resolve(output);
      else reject(new Error(`Animation renderer exited ${exitSignal ?? code}. ${tail.trim()}`));
    });
  });
}

async function movieFrameRate(movie: string, cwd: string, signal: AbortSignal) {
  const result: unknown = JSON.parse(await runRenderer("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate,width,height", "-of", "json", movie], cwd, signal, true));
  const stream = isRecord(result) && Array.isArray(result.streams) ? result.streams[0] : undefined;
  if (!isRecord(stream) || typeof stream.width !== "number" || !Number.isInteger(stream.width) || stream.width <= 0 || typeof stream.height !== "number" || !Number.isInteger(stream.height) || stream.height <= 0) throw new Error("Animation renderer did not produce a valid video stream.");
  const rate = typeof stream.avg_frame_rate === "string" ? stream.avg_frame_rate.split("/").map(Number) : [];
  if (rate.length !== 2 || !rate[1]) throw new Error("Animation renderer did not produce a valid video frame rate.");
  return parseSequenceMetadata({ frameRate: rate[0] / rate[1] }).frameRate;
}

export async function renderAnimation(id: string, project: string, engine?: "manim" | "hyperframes", externalSignal?: AbortSignal) {
  const operation = beginOperation(project, id, externalSignal);
  const { signal } = operation.controller;
  const data = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  let staging: string | undefined;
  try {
    const { root, animations } = await animationRegistry(project);
    signal.throwIfAborted();
    const animation = await readAnimation(id, root, animations[id]);
    if (engine && animation.engine !== engine) throw new Error(`Animation ${id} is not a ${engine} animation.`);
    lockOutputs(operation, root, [animation.output]);
    await mkdir(dirname(animation.output), { recursive: true });
    staging = await mkdtemp(join(dirname(animation.output), ".animation-"));
    const rendered = join(staging, animation.transparent ? "render" : "render.mp4");
    const movie = animation.transparent ? join(staging, "render.mov") : rendered;
    if (animation.engine === "manim") {
      const python = process.env.DIFFUSION_PYTHON ?? join(data, "diffusion-studio", "python", "bin", "python");
      await runRenderer(python, [
        "-m", "manim", "render", "--renderer", "cairo", "--quality", "h", "--fps", String(animation.frameRate), "--format", animation.transparent ? "mov" : "mp4",
        ...(animation.transparent ? ["--transparent"] : []),
        "--media_dir", join(staging, "media"), "--output_file", movie, animation.entry, animation.scene,
      ], animation.source, signal);
    } else {
      const hyperframes = process.env.DIFFUSION_HYPERFRAMES_BIN ?? join(data, "diffusion-studio", "tools", "node_modules", ".bin", "hyperframes");
      await runRenderer(hyperframes, [
        "render", ...(animation.entry ? ["--composition", animation.entry] : []), "--output", movie,
        ...(animation.frameRate === undefined ? [] : ["--fps", String(animation.frameRate)]),
        "--quality", "high", "--format", animation.transparent ? "mov" : "mp4", "--workers", "1",
        "--low-memory-mode", "--strict", "--no-best-effort",
      ], animation.source, signal);
    }
    const info = await lstat(movie);
    if (!info.isFile() || info.size === 0) throw new Error(`Animation renderer did not produce a non-empty ${animation.transparent ? "MOV" : "MP4"}.`);
    const frameRate = await movieFrameRate(movie, animation.source, signal);
    if (animation.transparent) {
      await mkdir(rendered);
      let alphaFilter: string | undefined;
      if (animation.engine === "manim") {
        const parameters = await runRenderer("ffmpeg", ["-hide_banner", "-h", "filter=setparams"], animation.source, signal, true);
        // Newer FFmpeg negotiates alpha modes. Older swscale rounds 8-bit alpha
        // during planar conversion, so retain the original alpha separately.
        alphaFilter = /\balpha_mode\b/.test(parameters)
          ? "setparams=alpha_mode=premultiplied,format=gbrap,unpremultiply=inplace=1,format=rgba"
          : "split[colors][alpha];[alpha]alphaextract[alpha];[colors]format=gbrap16le,unpremultiply=inplace=1,format=rgb24[colors];[colors][alpha]alphamerge";
      }
      await runRenderer("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-xerror", "-i", movie,
        // Cairo's MOV stores premultiplied colors; HyperFrames already writes straight alpha.
        ...(alphaFilter ? ["-vf", alphaFilter] : []),
        "-map", "0:v:0", "-fps_mode", "passthrough", "-pix_fmt", "rgba", join(rendered, "frame%06d.png"),
      ], animation.source, signal);
      await writeFile(join(rendered, SEQUENCE_METADATA_FILE), JSON.stringify({ frameRate }) + "\n", { flag: "wx" });
      await validateFrames(rendered, signal);
    }

    // Validate ownership again before swapping; incomplete previous previews remain recoverable.
    const current = await readAnimation(id, root, (await animationRegistry(root)).animations[id]);
    if (!isDeepStrictEqual(current, animation)) throw new Error("Animation registration changed during rendering. Render it again with the current settings.");
    signal.throwIfAborted();
    const backup = join(dirname(animation.output), `.${basename(animation.output)}.${randomUUID()}.bak`);
    // A folder swap must finish or roll back once the old folder has moved.
    if (animation.transparent) operation.cancellable = false;
    const backedUp = await (animation.transparent ? rename(animation.output, backup) : copyFile(animation.output, backup, constants.COPYFILE_EXCL)).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    });
    try {
      if (!animation.transparent) signal.throwIfAborted();
      operation.cancellable = false;
      await rename(rendered, animation.output);
    }
    catch (error) {
      if (animation.transparent && backedUp) await rename(backup, animation.output);
      throw error;
    }
    return { id, engine: animation.engine, transparent: animation.transparent, frameRate, source: animation.source, output: animation.output, ...(backedUp ? { backup } : {}) };
  } finally {
    try { if (staging) await rm(staging, { recursive: true, force: true }); }
    finally { endOperation(operation); }
  }
}

/** Create a fresh native JSX variation; a conversion never overwrites manual edits. */
export async function convertAnimation(id: string, project: string, options: { allowPartial?: boolean; signal?: AbortSignal } = {}) {
  const operation = beginOperation(project, id, options.signal);
  const { signal } = operation.controller;
  let staging: string | undefined;
  try {
    const { root, animations } = await animationRegistry(project);
    const animation = await readAnimation(id, root, animations[id]);
    const suffix = randomUUID().slice(0, 8);
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "animation";
    const output = await projectPath(root, `animations/${safeId}-editable-${suffix}.tsx`, "Editable animation output");
    lockOutputs(operation, root, [animation.output, output]);
    await mkdir(dirname(output), { recursive: true });
    staging = await mkdtemp(join(dirname(output), ".editable-"));
    const captured = join(staging, "capture.json");
    const data = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
    if (animation.engine === "manim") {
      const script = join(staging, "capture.py");
      await writeFile(script, manimEditableCapture, { flag: "wx" });
      const python = process.env.DIFFUSION_PYTHON ?? join(data, "diffusion-studio", "python", "bin", "python");
      await runRenderer(python, ["-B", script, animation.entry, animation.scene, captured, String(animation.frameRate), join(staging, "media"), String(animation.transparent)], animation.source, signal);
    } else {
      const script = join(staging, "capture.mjs");
      await writeFile(script, hyperframesEditableCapture, { flag: "wx" });
      const executable = process.env.DIFFUSION_HYPERFRAMES_BIN ?? join(data, "diffusion-studio", "tools", "node_modules", ".bin", "hyperframes");
      const browserModule = createRequire(await realpath(executable)).resolve("puppeteer-core");
      let chromium = process.env.DIFFUSION_CHROMIUM_BIN;
      if (!chromium) for (const candidate of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
        if (await optionalStat(candidate)) { chromium = candidate; break; }
      }
      if (!chromium) throw new Error("Editable HyperFrames conversion needs an installed Chromium. Set DIFFUSION_CHROMIUM_BIN to its executable path.");
      await runRenderer("node", [script, join(animation.source, animation.entry ?? "index.html"), captured, animation.frameRate === undefined ? "" : String(animation.frameRate), root, browserModule, chromium], animation.source, signal);
    }
    signal.throwIfAborted();
    if ((await stat(captured)).size > 128 * 1024 * 1024) throw new Error("Editable capture exceeds 128 MB. Split the animation into shorter components.");
    const { jsx, ...report } = capturedAnimationToJsx(JSON.parse(await readFile(captured, "utf8")), `editable-${safeId}-${suffix}`, id, options.allowPartial);
    const current = await readAnimation(id, root, (await animationRegistry(root)).animations[id]);
    if (!isDeepStrictEqual(current, animation)) throw new Error("Animation registration changed during conversion. Convert again with the current settings.");
    await rejectSymlinks(root, output, "Editable animation output");
    signal.throwIfAborted();
    const staged = join(staging, "animation.tsx");
    await writeFile(staged, jsx, { flag: "wx" });
    operation.cancellable = false;
    await link(staged, output);
    return { id, engine: animation.engine, output, ...report };
  } finally {
    try { if (staging) await rm(staging, { recursive: true, force: true }); }
    finally { endOperation(operation); }
  }
}

/** Export the rendered animation without requiring a scene or modifying its retained source. */
export async function exportAnimation(id: string, project: string, output: string, options: { overwrite?: boolean; signal?: AbortSignal } = {}) {
  const operation = beginOperation(project, id, options.signal);
  const { signal } = operation.controller;
  let staging: string | undefined;
  try {
    const { root, animations } = await animationRegistry(project);
    signal.throwIfAborted();
    const animation = await readAnimation(id, root, animations[id]);
    const format = animation.transparent ? "mov" : "mp4";
    if (!output.trim() || output.includes("\0")) throw new Error("Choose an export file path.");
    const destination = resolve(root, output);
    if (extname(destination).toLowerCase() !== `.${format}`) throw new Error(`This animation exports as ${format.toUpperCase()}. Choose a .${format} file.`);
    const sourceInfo = await optionalStat(animation.output);
    if (!sourceInfo) throw new Error("Render this animation before exporting it.");
    const checkDestination = async (registrations = animations) => {
      await rejectSymlinks(parse(destination).root, destination, "Export path");
      for (const config of Object.values(registrations)) {
        if (!isRecord(config)) continue;
        if (typeof config.source === "string" && inside(resolve(root, config.source), destination)) throw new Error("An export cannot overwrite animation source files.");
        if (typeof config.output === "string" && inside(resolve(root, config.output), destination)) throw new Error("An export cannot overwrite a registered animation output.");
      }
      const existing = await optionalStat(destination);
      if (existing) {
        if (!existing.isFile()) throw new Error("The export destination must be a regular file.");
        if (existing.dev === sourceInfo.dev && existing.ino === sourceInfo.ino) throw new Error("An export cannot overwrite its animation source.");
        if (!options.overwrite) throw new Error("The export file already exists. Choose another path or explicitly allow replacement.");
      }
    };
    await checkDestination();
    lockOutputs(operation, root, [animation.output, destination]);
    const sequence = animation.transparent ? await validateFrames(animation.output, signal) : undefined;
    if (!sequence && !sourceInfo.size) throw new Error("The rendered animation is empty. Render it again before exporting.");
    await mkdir(dirname(destination), { recursive: true });
    staging = await mkdtemp(join(dirname(destination), ".animation-"));
    const staged = join(staging, `export.${format}`);
    if (sequence) {
      await runRenderer("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-xerror", "-framerate", String(sequence.frameRate), "-start_number", String(sequence.start), "-i", sequence.pattern,
        "-map", "0:v:0", "-an", "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0", staged,
      ], root, signal);
    } else {
      await copyFile(animation.output, staged, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      await movieFrameRate(staged, root, signal);
    }
    const result = await lstat(staged);
    if (!result.isFile() || !result.size) throw new Error("Animation export did not produce a non-empty file.");
    await checkDestination((await animationRegistry(root)).animations);
    signal.throwIfAborted();
    operation.cancellable = false;
    // Linking publishes without overwriting a file created after the destination check.
    if (options.overwrite) await rename(staged, destination);
    else await link(staged, destination);
    return { id, output: destination, format, transparent: animation.transparent };
  } finally {
    try { if (staging) await rm(staging, { recursive: true, force: true }); }
    finally { endOperation(operation); }
  }
}
