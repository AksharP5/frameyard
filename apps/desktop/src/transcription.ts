/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { MediaTranscribeResult, TranscriptSegment, TranscriptWord } from "@diffusionstudio/dapi";

const execFileAsync = promisify(execFile);
// Serialize model loads: captioning several scenes must not load several
// Whisper models into a desktop machine's memory at once.
let pending: Promise<void> = Promise.resolve();

export async function transcribeLocal(path: string): Promise<MediaTranscribeResult> {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("Local transcription requires an absolute file path.");
  }
  if (!(await stat(path)).isFile()) throw new Error(`Not a media file: ${path}`);

  const run = pending.then(() => runTranscription(path));
  pending = run.then(() => {}, () => {});
  return run;
}

async function runTranscription(path: string): Promise<MediaTranscribeResult> {
  const script = process.resourcesPath && existsSync(join(process.resourcesPath, "local-media/transcribe.py"))
    ? join(process.resourcesPath, "local-media/transcribe.py")
    : join(__dirname, "../../../scripts/local-media/transcribe.py");
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
  const python = process.env.DIFFUSION_PYTHON || join(data, "diffusion-studio/python/bin/python");
  if (!existsSync(python)) {
    throw new Error(`Local transcription is not installed. Run bash ${join(dirname(script), "setup.sh")} to install its Python environment and Whisper model.`);
  }

  const { stdout } = await execFileAsync(python, [script, path], {
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, OMP_NUM_THREADS: "4", HF_HUB_DISABLE_TELEMETRY: "1" },
  }).catch((error: Error & { stderr?: string }) => {
    throw new Error(error.stderr?.trim() || error.message, { cause: error });
  });
  return parseTranscript(JSON.parse(stdout));
}

function isWord(value: unknown): value is TranscriptWord {
  if (!value || typeof value !== "object") return false;
  return "text" in value && typeof value.text === "string"
    && "start" in value && typeof value.start === "number" && Number.isFinite(value.start)
    && "end" in value && typeof value.end === "number" && Number.isFinite(value.end)
    && value.start >= 0 && value.end >= value.start;
}

function isSegment(value: unknown): value is TranscriptSegment {
  if (!value || typeof value !== "object") return false;
  return "text" in value && typeof value.text === "string"
    && "words" in value && Array.isArray(value.words) && value.words.every(isWord);
}

function parseTranscript(value: unknown): MediaTranscribeResult {
  if (!value || typeof value !== "object" || !("segments" in value)
    || !Array.isArray(value.segments) || !value.segments.every(isSegment)) {
    throw new Error("Local transcription returned an invalid word-timestamp transcript.");
  }
  return { segments: value.segments };
}
