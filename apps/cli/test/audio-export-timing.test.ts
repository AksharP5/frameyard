import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerAacEncoder } from "@mediabunny/aac-encoder";
import { AudioSample, AudioSampleSource, BufferTarget, Mp4OutputFormat, MovOutputFormat, Output } from "mediabunny";

registerAacEncoder();

async function encode(sampleRate: number, start: number, preserve: boolean, mov = false) {
  const target = new BufferTarget();
  const output = new Output({ target, format: mov ? new MovOutputFormat() : new Mp4OutputFormat() });
  const timestamps: number[] = [];
  const source = new AudioSampleSource({
    codec: "aac",
    bitrate: 192_000,
    onEncoderConfig: (config) => { Object.assign(config, { frameyardPreservePacketTimestamps: preserve }); },
    onEncodedPacket: (packet) => { timestamps.push(packet.timestamp); },
  });
  output.addAudioTrack(source);
  await output.start();
  const pcm = new Float32Array(sampleRate / 2);
  const impulses = [Math.round(sampleRate / 10), Math.round(sampleRate / 3)];
  for (const index of impulses) pcm[index] = 0.8;
  for (let index = 0; index < pcm.length; index += 128) {
    const sample = new AudioSample({
      data: pcm.slice(index, index + 128), format: "f32", numberOfChannels: 1,
      sampleRate, timestamp: start + index / sampleRate,
    });
    await source.add(sample);
    sample.close();
  }
  await output.finalize();
  assert.ok(target.buffer);
  return { buffer: target.buffer, timestamps, impulses };
}

test("AAC MP4/MOV export removes priming while preserving input timing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frameyard-aac-timing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const sampleRate of [44_100, 48_000]) {
    for (const start of [0, 0.01, 0.1]) {
      const mov = start === 0.1;
      const { buffer, timestamps, impulses } = await encode(sampleRate, start, true, mov);
      assert.ok(timestamps[0]! < start, "encoder priming must retain its original PTS");
      const path = join(directory, `${sampleRate}-${start}.${mov ? "mov" : "mp4"}`);
      await writeFile(path, new Uint8Array(buffer));
      const decoded = spawnSync("ffmpeg", [
        "-v", "error", "-copyts", "-i", path, "-af", "aresample=async=1:first_pts=0", "-f", "f32le", "pipe:1",
      ]);
      assert.equal(decoded.status, 0, decoded.stderr?.toString() ?? decoded.error?.message);
      for (const impulse of impulses) {
        const expected = impulse + Math.round(start * sampleRate);
        let peak = expected - 1500;
        for (let index = peak; index <= expected + 1500; index++) {
          if (Math.abs(decoded.stdout.readFloatLE(index * 4)) > Math.abs(decoded.stdout.readFloatLE(peak * 4))) peak = index;
        }
        assert.ok(Math.abs(peak - expected) <= 1, `${sampleRate} Hz, start ${start}: expected ${expected}, got ${peak}`);
      }
    }
  }
});

test("AAC packet timestamps retain the existing contract without the MP4/MOV opt-in", async () => {
  const { timestamps } = await encode(48_000, 0.1, false);
  assert.equal(timestamps[0], 0.1);
  assert.ok(timestamps.every((timestamp) => timestamp >= 0.1));
});
