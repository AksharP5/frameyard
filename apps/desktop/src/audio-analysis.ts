/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const pathSchema = z.string().min(1).refine(value => !value.includes("\0"), "Paths cannot contain null bytes");
const requestSchema = z.object({ dir: pathSchema, source: pathSchema }).strict();
const measurement = z.union([z.number(), z.string().trim().min(1)]).transform((value, context) => {
  if (value === "-inf") return null;
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  context.addIssue({ code: "custom", message: "FFmpeg returned an invalid loudness value" });
  return z.NEVER;
});
const resultSchema = z.object({ input_i: measurement, input_tp: measurement }).transform(value => ({
  integratedLufs: value.input_i,
  truePeakDbtp: value.input_tp,
}));

export type LoudnessRequest = z.infer<typeof requestSchema>;
export type LoudnessResult = z.infer<typeof resultSchema>;

const pending = new Map<string, Promise<LoudnessResult>>();
let queue = Promise.resolve();
const MAX_PENDING = 4;
const MAX_ANALYSIS_MS = 30 * 60 * 1_000;

/** Measure the rendered PCM mix. FFmpeg never writes to the input or produces a normalized file. */
export async function analyzeLoudness(input: LoudnessRequest): Promise<LoudnessResult> {
  const { dir, source } = requestSchema.parse(input);
  if (!isAbsolute(dir)) throw new Error("The project folder must be an absolute path");
  const root = await realpath(dir);
  const folder = join(root, ".cache", "audio-analysis");
  const path = resolve(root, source);
  if (dirname(path) !== folder || !/\.(wav|mov)$/i.test(path)) {
    throw new Error("Loudness analysis requires a PCM WAV or MOV file in the project's .cache/audio-analysis folder");
  }
  const active = pending.get(path);
  if (active) return active;
  if (pending.size >= MAX_PENDING) throw new Error("Loudness analysis queue is full. Wait for the current analysis to finish.");
  const job = queue.then(() => analyzeFile(root, folder, path)).finally(() => pending.delete(path));
  pending.set(path, job);
  queue = job.then(() => {}, () => {});
  return job;
}

async function analyzeFile(root: string, folder: string, path: string): Promise<LoudnessResult> {
  for (const directory of [join(root, ".cache"), folder]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The audio analysis cache must be a regular directory without symbolic links");
  }
  const expected = await lstat(path);
  if (!expected.isFile() || expected.isSymbolicLink()) throw new Error("Loudness analysis requires a regular audio file without symbolic links");
  if (await realpath(path) !== path) throw new Error("The audio analysis source leaves its cache folder");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.ino !== expected.ino || before.dev !== expected.dev) throw new Error("The audio analysis source changed before it could be read");
    if (!before.size) throw new Error("The audio analysis source is empty");
    const result = await measure(file.fd, path.toLowerCase().endsWith(".mov") ? "mov" : "wav");
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("The audio analysis source changed while it was being measured");
    }
    return result;
  } finally { await file.close(); }
}

function measure(fd: number, format: "wav" | "mov"): Promise<LoudnessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "info", "-nostats", "-nostdin", "-threads", "2", "-filter_threads", "1",
      "-max_alloc", "67108864", "-protocol_whitelist", "fd", "-fd", "3", "-f", format, "-i", "fd:",
      "-map", "0:a:0", "-vn", "-sn", "-dn", "-af", "loudnorm=I=-23:TP=-1:LRA=7:print_format=json",
      "-threads", "2", "-f", "null", "-",
    ], { stdio: ["ignore", "ignore", "pipe", fd] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, MAX_ANALYSIS_MS);
    child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-64_000); });
    child.once("error", error => {
      clearTimeout(timer);
      reject(new Error(`Could not start loudness analysis: ${error.message}`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) { reject(new Error("Loudness analysis exceeded 30 minutes. Analyze a shorter range.")); return; }
      if (code !== 0) { reject(new Error(`Loudness analysis failed: ${stderr.trim() || `ffmpeg exited with ${signal ?? code}`}`)); return; }
      const json = stderr.match(/\{\s*"input_i"\s*:[\s\S]*?\}/g)?.at(-1);
      if (!json) { reject(new Error("FFmpeg returned no loudness measurements")); return; }
      try { resolve(resultSchema.parse(JSON.parse(json))); }
      catch (error) { reject(new Error(`Could not read loudness measurements: ${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
    });
  });
}
