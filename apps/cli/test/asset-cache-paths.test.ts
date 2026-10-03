import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

const compiled = await build({
  stdin: { contents: 'export { isCacheFile } from "./cache";', resolveDir: fileURLToPath(new URL("../../../packages/assets/src/", import.meta.url)) },
  bundle: true, write: false, format: "esm", platform: "node",
});
const { isCacheFile } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`) as Pick<typeof import("../../../packages/assets/src/cache.ts"), "isCacheFile">;

test("cache paths include native media outputs without hiding authored lookalikes", () => {
  for (const path of ["cache", "cache/thumbnails/clip.webp", ".cache", ".cache/playback/clip.mp4", ".cache/original-audio/clip.wav"]) {
    assert.equal(isCacheFile(path), true, path);
  }
  for (const path of ["cache.ts", "cacheable/clip.mp4", ".cache.tsx", ".cacheable/clip.mp4", "assets/.cache/clip.mp4", ".gitignore"]) {
    assert.equal(isCacheFile(path), false, path);
  }
});
