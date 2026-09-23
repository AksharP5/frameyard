import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setImmediate } from "node:timers/promises";
import { closeOriginalVideo, disposeOriginalVideos, listMediaStreams, openOriginalVideo, prepareOriginalAudio, readOriginalVideo } from "../../desktop/src/media-original.ts";
import { preparePlaybackCopy } from "../../desktop/src/media-playback.ts";

const exec = promisify(execFile);
async function ffmpeg(args: string[]): Promise<Buffer> {
  const { stdout } = await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "studio-original-"));
  t.after(async () => { await disposeOriginalVideos(); await rm(dir, { recursive: true, force: true }); });
  return dir;
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function frames(count = 180, width = 8, height = 6): Buffer {
  const bytes = Buffer.alloc(count * width * height * 4);
  for (let frame = 0; frame < count; frame++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = (frame * width * height + y * width + x) * 4;
        bytes[at] = frame; bytes[at + 1] = x * 20; bytes[at + 2] = y * 30; bytes[at + 3] = (x + y) * 18;
      }
    }
  }
  return bytes;
}

test("original decoding preserves RGBA pixels through forward reads, fractional-rate seeks and backward reads", async (t) => {
  const dir = await fixture(t);
  const rgba = frames(), frameBytes = 8 * 6 * 4;
  await writeFile(join(dir, "input.rgba"), rgba);
  await ffmpeg(["-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "8x6", "-framerate", "60000/1001", "-i", join(dir, "input.rgba"), "-c:v", "ffv1", "-g", "12", "-pix_fmt", "bgra", join(dir, "source.mkv")]);
  const before = digest(await readFile(join(dir, "source.mkv")));
  const source = await openOriginalVideo({ dir, source: "source.mkv" }, 11);
  assert.equal(source.width, 8); assert.equal(source.height, 6);
  assert.ok(Math.abs(source.frameRate - 60_000 / 1_001) < 1e-3);
  const firstDecoderExit = Promise.withResolvers<void>();
  const spawned = channel('child_process');
  const onSpawn = (message: unknown) => {
    const child = (message as { process: ChildProcess }).process;
    child.once('exit', () => firstDecoderExit.resolve());
    spawned.unsubscribe(onSpawn);
  };
  spawned.subscribe(onSpawn);
  t.after(() => spawned.unsubscribe(onSpawn));
  for (const frame of [0, 1, 2, 10, 90, 91, 5, 179, 179]) {
    const result = await readOriginalVideo({ id: source.id, frame }, 11);
    assert.equal(result.data.length, frameBytes);
    assert.equal(digest(result.data), digest(rgba.subarray(frame * frameBytes, (frame + 1) * frameBytes)), `frame ${frame}`);
    if (frame === 0) {
      // All tiny frames fit in stdout. Let the producer exit before consuming
      // the rest, as happens when the editor is busy between frame requests.
      await firstDecoderExit.promise;
      await setImmediate();
    }
  }
  assert.throws(() => readOriginalVideo({ id: source.id, frame: 0 }, 12), /no longer open/);
  assert.equal(digest(await readFile(join(dir, "source.mkv"))), before);
  await closeOriginalVideo({ id: source.id }, 11);
  assert.throws(() => readOriginalVideo({ id: source.id, frame: 0 }, 11), /no longer open/);
});

test("native frames larger than the pipe buffer finish without losing frame boundaries", async (t) => {
  const dir = await fixture(t);
  const width = 320, height = 180, frameBytes = width * height * 4;
  const rgba = frames(6, width, height);
  await writeFile(join(dir, "input.rgba"), rgba);
  await ffmpeg(["-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-framerate", "60", "-i", join(dir, "input.rgba"), "-c:v", "ffv1", "-g", "1", "-pix_fmt", "bgra", join(dir, "source.mkv")]);
  // A separate process lets the timeout catch a read loop that starves its event loop.
  const script = `
    import { createHash } from "node:crypto";
    import { openOriginalVideo, readOriginalVideo, disposeOriginalVideos } from ${JSON.stringify(new URL("../../desktop/src/media-original.ts", import.meta.url).href)};
    const source = await openOriginalVideo({ dir: process.argv[1], source: "source.mkv" });
    try {
      const hashes = [];
      for (const frame of [0, 1, 3, 4, 2, 5]) {
        const result = await readOriginalVideo({ id: source.id, frame });
        hashes.push({ frame, length: result.data.length, hash: createHash("sha256").update(result.data).digest("hex") });
      }
      process.stdout.write(JSON.stringify(hashes));
    } finally { await disposeOriginalVideos(); }
  `;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "--eval", script, dir], { timeout: 15_000, killSignal: "SIGKILL" });
  const actual: { frame: number; length: number; hash: string }[] = JSON.parse(stdout);
  assert.deepEqual(actual, [0, 1, 3, 4, 2, 5].map(frame => ({
    frame, length: frameBytes, hash: digest(rgba.subarray(frame * frameBytes, (frame + 1) * frameBytes)),
  })));
});

test("original stream inspection bounds concurrent native probes and recovers after failure", async (t) => {
  const dir = await fixture(t);
  await ffmpeg(["-f", "lavfi", "-i", "color=s=8x6:r=30:d=0.2", "-c:v", "ffv1", join(dir, "source.mkv")]);
  let active = 0, peak = 0;
  const spawned = channel('child_process');
  const onSpawn = (message: unknown) => {
    const child = (message as { process: ChildProcess }).process;
    peak = Math.max(peak, ++active);
    child.once('exit', () => { active--; });
  };
  spawned.subscribe(onSpawn);
  t.after(() => spawned.unsubscribe(onSpawn));
  await Promise.all(Array.from({ length: 8 }, (_, index) => index % 2
    ? openOriginalVideo({ dir, source: 'source.mkv' })
    : listMediaStreams({ dir, source: 'source.mkv' })));
  assert.equal(peak, 1, 'metadata requests must not launch a process for every clip at once');
  await writeFile(join(dir, 'broken.mov'), 'invalid media');
  await assert.rejects(openOriginalVideo({ dir, source: 'broken.mov' }), /Could not inspect original media/);
  assert.deepEqual(await listMediaStreams({ dir, source: 'source.mkv' }), []);
});

test("original video respects display rotation and rejects HDR before producing frames", async (t) => {
  const dir = await fixture(t);
  await writeFile(join(dir, "input.rgba"), frames(3));
  await ffmpeg(["-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "8x6", "-framerate", "30", "-i", join(dir, "input.rgba"), "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "source.mp4")]);
  await ffmpeg(["-display_rotation:v:0", "90", "-i", join(dir, "source.mp4"), "-c", "copy", join(dir, "rotated.mp4")]);
  const source = await openOriginalVideo({ dir, source: "rotated.mp4" });
  assert.equal(source.width, 6); assert.equal(source.height, 8);
  const expected = await ffmpeg(["-i", join(dir, "rotated.mp4"), "-frames:v", "1", "-vf", "format=rgba", "-f", "rawvideo", "-"]);
  assert.equal(digest((await readOriginalVideo({ id: source.id, frame: 0 })).data), digest(expected));
  await ffmpeg(["-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "8x6", "-framerate", "30", "-i", join(dir, "input.rgba"), "-vf", "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc", "-c:v", "ffv1", join(dir, "hdr.mkv")]);
  await assert.rejects(openOriginalVideo({ dir, source: "hdr.mkv" }), /HDR source needs an SDR conversion/);
});

test("audio extraction selects original streams and preserves PCM samples without touching the source", async (t) => {
  const dir = await fixture(t);
  const source = join(dir, "two streams.mov");
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1", "-map", "0:a", "-map", "1:a", "-c:a", "pcm_f32le", "-metadata:s:a:0", "title=Microphone", "-metadata:s:a:1", "title=System", source]);
  const before = digest(await readFile(source));
  const streams = await listMediaStreams({ dir, source });
  assert.equal(streams.length, 2);
  assert.deepEqual(streams.map(stream => [stream.index, stream.codec, stream.channels, stream.sampleRate]), [[0, "pcm_f32le", 1, 48_000], [1, "pcm_f32le", 1, 48_000]]);
  const selected = await prepareOriginalAudio({ dir, source, stream: 1 });
  const actual = await ffmpeg(["-i", selected, "-map", "0:a:0", "-f", "f32le", "-"]);
  const expected = await ffmpeg(["-i", source, "-map", "0:a:1", "-f", "f32le", "-"]);
  assert.equal(digest(actual), digest(expected));
  assert.equal(await prepareOriginalAudio({ dir, source, stream: 1 }), selected);
  assert.notEqual(await prepareOriginalAudio({ dir, source, stream: 0 }), selected);
  await assert.rejects(prepareOriginalAudio({ dir, source, stream: 2 }), /Audio stream 3 was not found/);
  assert.equal(digest(await readFile(source)), before);
  assert.equal((await readdir(join(dir, ".cache", "original-audio"))).length, 2);
});

test("preview resolution is independently cached and retains all source audio streams", async (t) => {
  const dir = await fixture(t);
  const source = join(dir, "source.mkv");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=32x24:r=60:d=0.2", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-f", "lavfi", "-i", "sine=frequency=880:duration=0.2", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "ffv1", "-c:a", "pcm_s16le", source]);
  const full = await preparePlaybackCopy({ dir, source });
  const half = await preparePlaybackCopy({ dir, source, scale: 0.5 });
  const quarter = await preparePlaybackCopy({ dir, source, scale: 0.25 });
  assert.equal(new Set([full, half, quarter]).size, 3);
  const info = await openOriginalVideo({ dir, source: half });
  assert.equal(info.width, 16); assert.equal(info.height, 12); assert.equal(info.frameRate, 60);
  assert.equal((await listMediaStreams({ dir, source: half })).length, 2);
  assert.equal(await preparePlaybackCopy({ dir, source, scale: 0.5 }), half);
});

test("native audio keeps a delayed stream aligned to the video and preserves its samples", async (t) => {
  const dir = await fixture(t);
  const source = join(dir, "delayed.mkv");
  await ffmpeg(["-f", "lavfi", "-i", "color=s=8x6:r=30:d=2", "-itsoffset", "0.5", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-map", "0:v", "-map", "1:a", "-c:v", "ffv1", "-c:a", "pcm_s24le", source]);
  const selected = await prepareOriginalAudio({ dir, source });
  const actual = await ffmpeg(["-i", selected, "-map", "0:a:0", "-f", "f32le", "-"]);
  const samples = await ffmpeg(["-i", source, "-map", "0:a:0", "-f", "f32le", "-"]);
  const padding = 24_000 * 4;
  assert.equal(actual.length, padding + samples.length);
  assert.equal(actual.subarray(0, padding).some(byte => byte !== 0), false);
  assert.equal(digest(actual.subarray(padding)), digest(samples));
});

test("owner cleanup closes only its sessions and audio caches reject symbolic-link destinations", async (t) => {
  const dir = await fixture(t);
  await ffmpeg(["-f", "lavfi", "-i", "color=s=8x6:r=30:d=0.2", "-c:v", "ffv1", join(dir, "source.mkv")]);
  const first = await openOriginalVideo({ dir, source: "source.mkv" }, 1);
  const second = await openOriginalVideo({ dir, source: "source.mkv" }, 2);
  await disposeOriginalVideos(1);
  assert.throws(() => readOriginalVideo({ id: first.id, frame: 0 }, 1), /no longer open/);
  assert.equal((await readOriginalVideo({ id: second.id, frame: 0 }, 2)).data.length, 8 * 6 * 4);
  await assert.rejects(openOriginalVideo({ dir, source: "../outside.mkv" }), /leaves the project/);
  await mkdir(join(dir, "outside")); await mkdir(join(dir, ".cache"));
  await symlink(join(dir, "outside"), join(dir, ".cache", "original-audio"));
  await assert.rejects(prepareOriginalAudio({ dir, source: "source.mkv" }), /without symbolic links/);
  assert.deepEqual(await readdir(join(dir, "outside")), []);
});


test("VFR decoding uses the same timestamp grid for sequential and restarted reads", async (t) => {
  const dir = await fixture(t);
  await writeFile(join(dir, "input.rgba"), frames(60));
  await ffmpeg(["-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "8x6", "-framerate", "30", "-i", join(dir, "input.rgba"), "-vf", "setpts=if(lt(N\\,30)\\,N/(30*TB)\\,(1+(N-30)/10)/TB)", "-fps_mode", "vfr", "-c:v", "ffv1", "-g", "12", "-pix_fmt", "bgra", join(dir, "vfr.mkv")]);
  const source = await openOriginalVideo({ dir, source: "vfr.mkv" });
  const expected = await ffmpeg(["-i", join(dir, "vfr.mkv"), "-vf", `fps=${source.frameRate}:start_time=0:round=near,format=rgba`, "-f", "rawvideo", "-"]);
  const frameBytes = 8 * 6 * 4;
  const count = expected.length / frameBytes;
  for (const frame of [0, 1, Math.floor(count * 0.7), Math.floor(count * 0.7) + 1, 5, count - 2]) {
    const result = await readOriginalVideo({ id: source.id, frame });
    assert.equal(digest(result.data), digest(expected.subarray(frame * frameBytes, (frame + 1) * frameBytes)), `VFR frame ${frame}`);
  }
});

test("explicit video ordinals match the selected source and default selection honors disposition", async (t) => {
  const dir = await fixture(t);
  const source = join(dir, "two-videos.mkv");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=8x6:r=30:d=0.2", "-f", "lavfi", "-i", "color=c=blue:s=16x12:r=30:d=0.2", "-map", "0:v", "-map", "1:v", "-c:v", "ffv1", "-disposition:v:0", "0", "-disposition:v:1", "default", source]);
  const primary = await openOriginalVideo({ dir, source });
  const first = await openOriginalVideo({ dir, source, stream: 0 });
  assert.equal(primary.width, 16); assert.equal(first.width, 8);
  const reference = await ffmpeg(["-i", source, "-map", "0:v:0", "-frames:v", "1", "-vf", "format=rgba", "-f", "rawvideo", "-"]);
  assert.equal(digest((await readOriginalVideo({ id: first.id, frame: 0 })).data), digest(reference));
  await assert.rejects(openOriginalVideo({ dir, source, stream: 2 }), /No video track/);
  const preview = await preparePlaybackCopy({ dir, source });
  const proxy = await openOriginalVideo({ dir, source: preview });
  assert.equal(proxy.width, 16);
});
