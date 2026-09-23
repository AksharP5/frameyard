import assert from "node:assert/strict";
import { test } from "node:test";
import { annotationSchema, regionBetween, timeRangeSchema } from "../../desktop/src/annotation-contracts.ts";

test("region coordinates survive reversed drags and clamp to the frame", () => {
  assert.deepEqual(regionBetween({ x: 0.75, y: 0.8 }, { x: 0.25, y: 0.3 }), { x: 0.25, y: 0.3, width: 0.5, height: 0.5 });
  assert.deepEqual(regionBetween({ x: 0.2, y: 0.25 }, { x: 2, y: -1 }), { x: 0.2, y: 0, width: 0.8, height: 0.25 });
});

test("time ranges require a finite forward interval and identify its scene and frame rate", () => {
  const range = { sceneId: "demo", sceneName: "Demo", start: 1, end: 2, frameRate: 30 };
  assert.deepEqual(timeRangeSchema.parse(range), range);
  for (const invalid of [{ start: -1 }, { end: 1 }, { end: 0 }, { end: Infinity }, { start: NaN }, { frameRate: 0 }, { sceneId: "" }]) {
    assert.equal(timeRangeSchema.safeParse({ ...range, ...invalid }).success, false);
  }
});

test("annotations require a bounded region, scene time and PNG frame", () => {
  const annotation = {
    sceneId: "demo", sceneName: "Demo", time: 2, frame: 60,
    sceneSize: { width: 1920, height: 1080 },
    region: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, note: "Blur this",
    imageUrl: "data:image/png;base64,aGVsbG8=",
  };
  assert.deepEqual(annotationSchema.parse(annotation), annotation);
  for (const invalid of [
    { region: { ...annotation.region, width: 0 } },
    { region: { ...annotation.region, x: 0.75 } },
    { time: -1 }, { frame: 2.5 }, { sceneSize: { width: 0, height: 1080 } },
    { imageUrl: "https://unrelated.example/image.png" },
  ]) assert.equal(annotationSchema.safeParse({ ...annotation, ...invalid }).success, false);
});
