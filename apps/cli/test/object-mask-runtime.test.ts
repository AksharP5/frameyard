import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { encodeMaskFile, MaskFile } from "../../../packages/assets/src/mask.ts";
import type { MaskOutlineSink } from "../../../packages/assets/src/mask-outline.ts";
import type { MaskAsset } from "../../../packages/assets/src/types.ts";
import type { MaskDecoder } from "../../../packages/runtime/src/media/mask.ts";

const header = { gridWidth: 2, gridHeight: 2, width: 2, height: 2, frameRate: 30 };

async function fileWithRuns(runs: number[]) {
  const bytes = new Uint8Array(await encodeMaskFile(header, [null]).arrayBuffer());
  const table = new DataView(bytes.buffer);
  const tableStart = 12 + table.getUint32(8, true);
  table.setUint32(tableStart + 4, runs.length, true);
  return MaskFile.read(new Blob([bytes, Uint8Array.from(runs)]));
}

test("mask files reject frame ranges outside their data", async () => {
  for (const corruption of ["offset", "length"]) {
    const bytes = new Uint8Array(await encodeMaskFile(header, [{ field: Int8Array.of(1, 2, 3, 4), score: 1, iou: 1 }]).arrayBuffer());
    const table = new DataView(bytes.buffer);
    const tableStart = 12 + table.getUint32(8, true);
    table.setUint32(tableStart + (corruption === "offset" ? 0 : 4), 0xffffffff, true);
    await assert.rejects(MaskFile.read(new Blob([bytes])), /mask.*cut short|mask.*malformed/i);
  }
});

test("truncated mask literals fail instead of retaining the previous frame", async () => {
  const frames = [Int8Array.of(1, 2, 3, 4), Int8Array.of(5, 6, 7, 8)];
  const bytes = new Uint8Array(await encodeMaskFile(header, frames.map(field => ({ field, score: 1, iou: 1 }))).arrayBuffer());
  const table = new DataView(bytes.buffer);
  const tableStart = 12 + table.getUint32(8, true);
  table.setUint32(tableStart + 16 + 4, 2, true);
  const file = await MaskFile.read(new Blob([bytes]));
  const field = new Int8Array(4);
  assert.equal(file.field(0, field), true);
  assert.deepEqual(field, frames[0]);
  assert.throws(() => file.field(1, field), /mask.*malformed/i);
});

test("mask frames require complete valid runs covering their grid exactly", async () => {
  for (const runs of [
    [0x90], // unterminated varint
    [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0], // oversized varint
    [0], // empty run
    [19], // unknown run kind
    [20], // run beyond the grid
    [8], // incomplete grid
    [16, 16], // extra runs after the grid
    [18, 5], // incomplete literal
    [18, 0x80, 1, 2, 3], // field bytes cannot represent -128
  ]) {
    const file = await fileWithRuns(runs);
    assert.throws(() => file.field(0, new Int8Array(4)), /mask.*malformed/i, `runs ${runs}`);
  }
  const file = await fileWithRuns([8, 9]);
  const field = new Int8Array(4);
  assert.equal(file.field(0, field), true);
  assert.deepEqual(field, Int8Array.of(-127, -127, 127, 127));
});

const compiled = await build({
  entryPoints: [new URL("../../../packages/assets/src/mask-outline.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "cjs", platform: "node",
});
const outlineExports: { traceMask?: (field: ArrayLike<number>, width: number, height: number, sink: MaskOutlineSink, smoothing: number) => void } = {};
const outlineContext = { module: { exports: outlineExports } };
runInNewContext(compiled.outputFiles[0].text, outlineContext);
const traceMask = outlineContext.module.exports.traceMask!;

test("empty masks have no outline at any smoothing while positive masks retain their edge", () => {
  const commands: string[] = [];
  const sink: MaskOutlineSink = {
    moveTo() { commands.push("move"); }, lineTo() { commands.push("line"); },
    quadraticCurveTo() { commands.push("curve"); }, closePath() { commands.push("close"); },
  };
  for (const smoothing of [0, 0.25, 1]) {
    traceMask(Int8Array.of(-127, -1, 0, -2), 2, 2, sink, smoothing);
    assert.deepEqual(commands, []);
  }
  traceMask(Int8Array.of(-127, 127, 127, -127), 2, 2, sink, 0.25);
  assert.ok(commands.includes("move"));
  assert.ok(commands.includes("close"));
});

const runtime = await build({
  entryPoints: [new URL("../../../packages/runtime/src/media/mask.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{ name: "mask-asset-boundary", setup(build) {
    build.onResolve({ filter: /^\.\.\/actions\/assets$/ }, () => ({ path: "asset-read", namespace: "mask-test" }));
    build.onLoad({ filter: /^asset-read$/, namespace: "mask-test" }, () => ({ contents: "export const getAssetFile = asset => asset.handle.getFile();" }));
  } }],
});

function decoderFor(blob: Blob, realtime: boolean) {
  class Canvas {
    width: number;
    height: number;
    constructor(width: number, height: number) { this.width = width; this.height = height; }
    getContext() { return { clearRect() {}, fill() {} }; }
  }
  class Path implements MaskOutlineSink {
    moveTo() {} lineTo() {} quadraticCurveTo() {} closePath() {} addPath() {}
  }
  const exports: { MaskDecoder?: typeof MaskDecoder } = {};
  const context = { module: { exports }, OffscreenCanvas: Canvas, Path2D: Path, DOMMatrix: class {}, TextDecoder, Error };
  runInNewContext(runtime.outputFiles[0].text, context);
  const asset: MaskAsset = {
    id: "tracked", path: "tracked.mask", source: "assets/tracked.mask", createdAt: "", mimeType: "application/x-diffusionstudio-mask",
    type: "MASK", width: 2, height: 2, duration: 2 / 30, frameRate: 30,
    handle: { async getFile() { return new File([blob], "tracked.mask"); } },
  };
  return new context.module.exports.MaskDecoder!(asset, realtime);
}

test("failed masks clear old outlines in preview and reject export reads and seeks", async () => {
  for (const stage of ["read", "frame"]) {
    const bytes = new Uint8Array(await encodeMaskFile(header, [
      { field: Int8Array.of(1, 2, 3, 4), score: 1, iou: 1 },
      { field: Int8Array.of(5, 6, 7, 8), score: 1, iou: 1 },
    ]).arrayBuffer());
    const table = new DataView(bytes.buffer);
    const tableStart = 12 + table.getUint32(8, true);
    table.setUint32(tableStart + 16 + 4, stage === "read" ? 0xffffffff : 2, true);

    for (const realtime of [false, true]) {
      const decoder = decoderFor(new Blob([bytes]), realtime);
      try {
        await decoder.initialized;
        if (stage === "frame") {
          await decoder.seekTo(0, 30);
          assert.ok(decoder.getOutline(0.25));
          assert.ok(decoder.toBitmap());
        }
        const seek = async () => { await decoder.seekTo(1, 30); };
        if (realtime) await seek();
        else await assert.rejects(seek, /tracked\.mask.*mask frame 1.*(cut short|malformed)/i);
        assert.equal(decoder.errored, true);
        assert.equal(decoder.toBitmap(), null);
        assert.equal(decoder.getOutline(0.25), null);
        if (realtime) await seek();
        else await assert.rejects(seek, /tracked\.mask/);
      } finally { decoder.dispose(); }
    }
  }
});
