import assert from "node:assert/strict";
import { test } from "node:test";
import { getExportFrameRange } from "../../../packages/encoder/src/utils.ts";

test("export frame range clamps the workarea to the scene", () => {
  assert.deepEqual(getExportFrameRange(120, { start: 30, end: 90 }), { start: 30, end: 90, frames: 60 });
  assert.deepEqual(getExportFrameRange(120, { start: 30, end: 0 }), { start: 30, end: 120, frames: 90 });
  assert.deepEqual(getExportFrameRange(120, { start: -20, end: 200 }), { start: 0, end: 120, frames: 120 });
});

test("export frame range rejects empty ranges before audio setup", () => {
  assert.throws(() => getExportFrameRange(120, { start: 90, end: 30 }), /contains no frames/);
  assert.throws(() => getExportFrameRange(120, { start: 120, end: 120 }), /contains no frames/);
});
