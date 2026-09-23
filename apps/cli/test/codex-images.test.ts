import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_CHAT_IMAGE_BYTES, codexImagesSchema } from "../../desktop/src/codex-image-contracts.ts";

function image(bytes: number, type = "png") {
  return { name: "Reference", url: `data:image/${type};base64,${Buffer.alloc(bytes).toString("base64")}` };
}

test("chat images accept supported local data URLs and reject external or malformed payloads", () => {
  for (const type of ["png", "jpeg", "webp", "gif"]) assert.equal(codexImagesSchema.safeParse([image(3, type)]).success, true);
  for (const url of ["https://example.com/image.png", "file:///image.png", "data:image/svg+xml;base64,AAAA", "data:image/png;base64,", "data:image/png;base64,AAA", "data:image/png;base64,A===", "data:image/png;base64,AA A"]) {
    assert.equal(codexImagesSchema.safeParse([{ name: "Bad image", url }]).success, false, url);
  }
});

test("chat image byte limits count decoded bytes and padding, with a separate total limit", () => {
  const maximum = image(MAX_CHAT_IMAGE_BYTES);
  assert.equal(codexImagesSchema.safeParse([maximum, maximum]).success, true);
  assert.equal(codexImagesSchema.safeParse([image(MAX_CHAT_IMAGE_BYTES + 1)]).success, false);
  assert.equal(codexImagesSchema.safeParse([maximum, maximum, image(1)]).success, false);
  assert.equal(codexImagesSchema.safeParse(Array.from({ length: 5 }, () => image(1))).success, false);
  assert.deepEqual(codexImagesSchema.parse([]), []);
});
