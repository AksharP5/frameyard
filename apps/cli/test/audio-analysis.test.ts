import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeLoudness } from "../../desktop/src/audio-analysis.ts";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "studio-loudness-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const folder = join(dir, ".cache", "audio-analysis");
  await mkdir(folder, { recursive: true });
  return { dir, folder };
}

function wav(amplitude: number): Buffer {
  const samples = 48_000 * 4;
  const buffer = Buffer.alloc(44 + samples * 4);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(48_000, 24);
  buffer.writeUInt32LE(48_000 * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 4, 40);
  for (let frame = 0; frame < samples; frame++) {
    const sample = Math.round(Math.sin(frame / 48_000 * 2 * Math.PI * 1_000) * amplitude * 32_767);
    buffer.writeInt16LE(sample, 44 + frame * 4);
    buffer.writeInt16LE(sample, 46 + frame * 4);
  }
  return buffer;
}

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("loudness analysis measures a known PCM tone and silence without changing source files", async (t) => {
  const f = await fixture(t);
  const tone = wav(0.1), silence = wav(0);
  await Promise.all([writeFile(join(f.folder, "tone.wav"), tone), writeFile(join(f.folder, "silence.wav"), silence)]);
  const [measured, silent] = await Promise.all([
    analyzeLoudness({ dir: f.dir, source: ".cache/audio-analysis/tone.wav" }),
    analyzeLoudness({ dir: f.dir, source: join(f.folder, "silence.wav") }),
  ]);
  assert.ok(measured.integratedLufs !== null && Math.abs(measured.integratedLufs - -20) < 0.3, JSON.stringify(measured));
  assert.ok(measured.truePeakDbtp !== null && Math.abs(measured.truePeakDbtp - -20) < 0.15, JSON.stringify(measured));
  assert.deepEqual(silent, { integratedLufs: null, truePeakDbtp: null });
  assert.equal(digest(await readFile(join(f.folder, "tone.wav"))), digest(tone));
  assert.equal(digest(await readFile(join(f.folder, "silence.wav"))), digest(silence));
  assert.deepEqual((await readdir(f.folder)).sort(), ["silence.wav", "tone.wav"]);
});

test("loudness analysis rejects outside files, symlinks, directories and empty inputs", async (t) => {
  const f = await fixture(t);
  const outside = join(f.dir, "original.wav");
  await writeFile(outside, wav(0.1));
  await assert.rejects(analyzeLoudness({ dir: f.dir, source: outside }), /\.cache\/audio-analysis/);
  await assert.rejects(analyzeLoudness({ dir: f.dir, source: "../original.wav" }), /\.cache\/audio-analysis/);
  await symlink(outside, join(f.folder, "link.wav"));
  await assert.rejects(analyzeLoudness({ dir: f.dir, source: join(f.folder, "link.wav") }), /symbolic links/);
  await mkdir(join(f.folder, "directory.wav"));
  await assert.rejects(analyzeLoudness({ dir: f.dir, source: join(f.folder, "directory.wav") }), /regular audio file/);
  await writeFile(join(f.folder, "empty.wav"), "");
  await assert.rejects(analyzeLoudness({ dir: f.dir, source: join(f.folder, "empty.wav") }), /empty/);
  await rm(f.folder, { recursive: true });
  await symlink(f.dir, f.folder);
  await assert.rejects(analyzeLoudness({ dir: f.dir, source: join(f.folder, "original.wav") }), /regular directory/);
});

test("a failed analysis reports the decoder error and does not block the next queued request", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.folder, "invalid.wav"), "invalid WAV data");
  await writeFile(join(f.folder, "valid.wav"), wav(0));
  const failed = analyzeLoudness({ dir: f.dir, source: join(f.folder, "invalid.wav") });
  const next = analyzeLoudness({ dir: f.dir, source: join(f.folder, "valid.wav") });
  await assert.rejects(failed, /Loudness analysis failed:.*invalid|Loudness analysis failed:[\s\S]*Invalid/);
  assert.deepEqual(await next, { integratedLufs: null, truePeakDbtp: null });
  assert.equal(await readFile(join(f.folder, "invalid.wav"), "utf8"), "invalid WAV data");
});


test("seekable PCM-f32 MOV analysis supports a movie whose index follows the audio data", async (t) => {
  const f = await fixture(t);
  const source = join(f.folder, "mix.mov");
  await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "4", "-c:a", "pcm_f32le", source]);
  const original = await readFile(source);
  assert.ok(original.indexOf(Buffer.from("moov")) > original.indexOf(Buffer.from("mdat")));
  assert.deepEqual(await analyzeLoudness({ dir: f.dir, source }), { integratedLufs: null, truePeakDbtp: null });
  assert.equal(digest(await readFile(source)), digest(original));
});
