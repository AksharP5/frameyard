import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import type { TrackRequest } from "../../../packages/sam2/src/video.ts";

const compiled = await build({
  entryPoints: [new URL("../../../packages/sam2/src/video.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{ name: "sample-sink", setup(build) {
    build.onResolve({ filter: /^mediabunny$/ }, () => ({ path: "sink", namespace: "sample-test" }));
    build.onLoad({ filter: /^sink$/, namespace: "sample-test" }, () => ({ contents: "export const VideoSampleSink = globalThis.SampleSink;" }));
  } }],
});

function fixture(options: {
  seed?: () => void;
  track?: (timestamp: number) => Promise<void> | void;
  decode?: (timestamp: number) => void;
  convert?: () => void;
  close?: (timestamp: number) => void;
  finish?: () => void;
} = {}) {
  const samples: { timestamp: number; closes: number; frameCloses: number }[] = [];
  const makeSample = (timestamp: number) => {
    options.decode?.(timestamp);
    const state = { timestamp, closes: 0, frameCloses: 0 };
    samples.push(state);
    return {
      timestamp,
      close() { state.closes++; options.close?.(timestamp); },
      toVideoFrame() {
        options.convert?.();
        return { timestamp, close() { state.frameCloses++; } };
      },
    };
  };
  class SampleSink {
    async getSample(timestamp: number) { return makeSample(timestamp); }
    async *samplesAtTimestamps(timestamps: number[]) {
      try { for (const timestamp of timestamps) yield makeSample(timestamp); }
      finally { options.finish?.(); }
    }
  }
  const mask = { logits: Float32Array.of(1), size: 1, score: 1, iou: 1 };
  const model = {
    async seed() { options.seed?.(); return mask; },
    async track(frame: { timestamp: number }) { await options.track?.(frame.timestamp); return mask; },
    async hold() {},
    rewind() {},
  };
  type Request = Pick<TrackRequest, "timestamps" | "seedIndex" | "points" | "signal" | "onMask"> & { track: { rotation: 0 } };
  const exports: {
    trackObject?: (model: typeof model, request: Request) => Promise<void>;
    holdFrame?: (model: typeof model, request: { track: { rotation: 0 }; timestamp: number }) => Promise<void>;
  } = {};
  const context = { module: { exports }, SampleSink };
  runInNewContext(compiled.outputFiles[0].text, context);
  const masks: number[] = [];
  const run = (timestamps = [0, 1, 2], seedIndex = 0, signal?: AbortSignal) => context.module.exports.trackObject!(model, {
    track: { rotation: 0 }, timestamps, seedIndex, signal, points: [{ x: 0.5, y: 0.5, label: 1 }],
    onMask(index) { masks.push(index); },
  });
  return { samples, masks, run, hold: () => context.module.exports.holdFrame!(model, { track: { rotation: 0 }, timestamp: 0 }) };
}

test("tracking closes each decoded sample and converted frame once in both directions", async () => {
  const tracking = fixture();
  await tracking.run([0, 1, 2, 3, 4], 2);
  assert.deepEqual(tracking.masks, [2, 3, 4, 1, 0]);
  assert.equal(tracking.samples.length, 5);
  for (const sample of tracking.samples) {
    assert.equal(sample.closes, 1);
    assert.equal(sample.frameCloses, 1);
  }
});

test("cancelled tracking releases the forward sample already prefetched", async () => {
  const controller = new AbortController();
  const tracking = fixture({ seed() { controller.abort(); } });
  await tracking.run([0, 1, 2], 0, controller.signal);
  assert.deepEqual(tracking.masks, [0]);
  assert.equal(tracking.samples.length, 3);
  for (const sample of tracking.samples) assert.equal(sample.closes, 1);
});

test("forward inference errors survive cleanup failures and release prefetched samples", async () => {
  const inference = new Error("inference failed");
  const tracking = fixture({
    track() { throw inference; },
    close(timestamp) { if (timestamp > 0) throw new Error("sample cleanup failed"); },
    finish() { throw new Error("iterator cleanup failed"); },
  });
  await assert.rejects(tracking.run(), error => error === inference);
  assert.equal(tracking.samples.length, 3);
  for (const sample of tracking.samples) assert.equal(sample.closes, 1);
});

test("reverse decoding and inference errors release all samples retained in the batch", async () => {
  for (const stage of ["decode", "inference"]) {
    const failure = new Error(`${stage} failed`);
    const tracking = fixture({
      decode(timestamp) { if (stage === "decode" && timestamp === 2) throw failure; },
      track() { if (stage === "inference") throw failure; },
    });
    await assert.rejects(tracking.run([0, 1, 2, 3, 4], 4), error => error === failure);
    for (const sample of tracking.samples) assert.equal(sample.closes, 1, `sample ${sample.timestamp} after ${stage} failure`);
  }
});

test("failed frame conversion still closes the decoded sample", async () => {
  for (const operation of ["hold", "track"]) {
    const failure = new Error("conversion failed");
    const tracking = fixture({ convert() { throw failure; } });
    await assert.rejects(operation === "hold" ? tracking.hold() : tracking.run(), error => error === failure);
    assert.equal(tracking.samples.length, 1);
    assert.equal(tracking.samples[0].closes, 1);
    assert.equal(tracking.samples[0].frameCloses, 0);
  }
});

test("a prefetched decode failure waits for inference without an unhandled rejection", async () => {
  const failure = new Error("prefetched decode failed");
  const tracking = fixture({
    decode(timestamp) { if (timestamp === 2) throw failure; },
    async track() { await setImmediate(); await setImmediate(); },
  });
  await assert.rejects(tracking.run(), error => error === failure);
  for (const sample of tracking.samples) assert.equal(sample.closes, 1);
});
