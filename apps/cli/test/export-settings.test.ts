import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";
import * as mediabunny from "mediabunny";

const built = await build({
  entryPoints: [fileURLToPath(new URL("../../web/src/engine/export-settings.ts", import.meta.url))],
  bundle: true, write: false, format: "cjs", platform: "node", external: ["mediabunny"],
});
const module = { exports: {} as typeof import("../../web/src/engine/export-settings") };
runInThisContext(`(function(module,exports,require){${built.outputFiles[0].text}\n})`)(module, module.exports, (specifier: string) => {
  assert.equal(specifier, "mediabunny");
  return mediabunny;
});
const { resolveExportSettings, getExportCodecs, changeExportFormat, getExportError } = module.exports;
const { Mp4OutputFormat, MovOutputFormat, WebMOutputFormat, OggOutputFormat } = mediabunny;
const size = { width: 1920, height: 1080 };

test("quick export preserves saved settings and inherits project FPS only when unspecified", () => {
  const saved = Object.freeze({
    format: "webm" as const,
    video: Object.freeze({ fps: 60, resolution: 2160, codec: "vp9" as const, bitrate: 24e6 }),
    audio: Object.freeze({ codec: "opus" as const, sampleRate: 48000 }),
  });
  assert.deepEqual(resolveExportSettings(saved, 30), saved);
  assert.equal(resolveExportSettings(null, 60).video?.fps, 60);
  assert.equal(resolveExportSettings(undefined, 24).video?.fps, 24);
  assert.equal(resolveExportSettings({ video: { resolution: 720 } }, 59.94).video?.fps, 59.94);
  assert.equal(resolveExportSettings(saved, 24).video?.fps, 60);
});

test("format changes choose compatible codecs while retaining quality, FPS and stream settings", () => {
  const original = Object.freeze({
    format: "mp4" as const,
    video: Object.freeze({ codec: "avc" as const, fps: 60, resolution: 2160, bitrate: 40e6 }),
    audio: Object.freeze({ codec: "aac" as const, bitrate: 256e3, sampleRate: 48000, enabled: false }),
  });
  const webm = changeExportFormat(original, "webm");
  assert.deepEqual(webm, {
    format: "webm", video: { ...original.video, codec: "vp9" }, audio: { ...original.audio, codec: "opus" },
  });
  const ogg = changeExportFormat(original, "ogg");
  assert.deepEqual(ogg, {
    format: "ogg", video: original.video, audio: { ...original.audio, codec: "opus" },
  });
  assert.deepEqual(changeExportFormat(webm, "mov"), { ...webm, format: "mov" });
  assert.equal(changeExportFormat({ video: { codec: "prores" } }, "mov").video?.codec, "prores");
  assert.equal(original.video.codec, "avc");
  assert.equal(original.audio.codec, "aac");
});

test("every offered codec matches the installed container contract", () => {
  const formats = {
    mp4: new Mp4OutputFormat(), mov: new MovOutputFormat(), webm: new WebMOutputFormat(), ogg: new OggOutputFormat(),
  };
  for (const format of ["mp4", "mov", "webm", "ogg"] as const) {
    const offered = getExportCodecs(format);
    assert.ok(offered.audio.length);
    for (const codec of offered.audio) assert.ok(formats[format].getSupportedAudioCodecs().includes(codec));
    for (const codec of offered.video) assert.ok(formats[format].getSupportedVideoCodecs().includes(codec));
  }
  assert.deepEqual(getExportCodecs("webm"), { video: ["vp9", "av1", "vp8"], audio: ["opus"] });
  assert.deepEqual(getExportCodecs("ogg"), { video: [], audio: ["opus"] });
});

test("invalid saved combinations report the problem without silently replacing settings", async () => {
  const saved = Object.freeze({ format: "webm" as const, video: Object.freeze({ codec: "avc" as const, fps: 60 }) });
  assert.match((await getExportError(saved, size))!, /WEBM cannot contain AVC video/);
  assert.equal(saved.video.codec, "avc");
  assert.match((await getExportError({ format: "ogg", audio: { codec: "aac", enabled: false } }, size))!, /OGG cannot contain AAC audio/);
  assert.match((await getExportError({ video: { enabled: false }, audio: { enabled: false } }, size))!, /Enable video or audio/);
  assert.equal(await getExportError({ video: { enabled: false }, audio: { codec: "aac" } }, size), undefined);
});

test("unavailable encoders report the selected codec and output settings", async () => {
  // Node has no WebCodecs encoders; container support alone must not count as encodability.
  assert.match((await getExportError({ video: { codec: "hevc", fps: 60 }, audio: { enabled: false } }, size))!, /Cannot encode HEVC at 1920×1080/);
  assert.match((await getExportError({ format: "ogg", audio: { codec: "opus", sampleRate: 96000 } }, size))!, /Cannot encode OPUS at 96 kHz/);
});
