import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ProjectFS } from "../../../packages/assets/src/fs.ts";
import type { Manifest } from "../../../packages/assets/src/manifest.ts";

const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../../../packages/assets/src/library.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "node",
});
const { AssetLibrary } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`) as typeof import("../../../packages/assets/src/library.ts");

function library(t: TestContext, writeManifest: ProjectFS["writeManifest"]) {
  const fs: ProjectFS = {
    async readManifest() { return null; },
    writeManifest,
    async list() { return []; },
    async stat() { return null; },
    async file() { throw new Error("This test does not read media"); },
    async write() {},
    async remove() {},
  };
  const result = new AssetLibrary(fs);
  t.after(() => result.dispose());
  return result;
}

test("settle reports failed saves and retries the same unsaved manifest", async (t) => {
  let failure: Error | undefined = new Error("manifest is not writable");
  let saved: Manifest | undefined;
  const assets = library(t, async (manifest) => {
    if (failure) throw failure;
    saved = manifest;
  });
  assert.equal(assets.saveState().status, "saved");
  assets.createFolder("Unpublished changes");
  assert.equal(assets.saveState().status, "dirty");
  const saving = assets.settle();
  assert.equal(assets.saveState().status, "saving");
  await assert.rejects(saving, failure);
  assert.deepEqual(assets.saveState(), { status: "failed", error: failure.message });
  assert.equal(saved, undefined);
  assets.createFolder("More unsaved changes");
  assert.deepEqual(assets.saveState(), { status: "failed", error: failure.message });
  await assert.rejects(assets.load(), failure);
  assert.deepEqual(assets.manifest().folders, ["More unsaved changes", "Unpublished changes"]);
  failure = undefined;
  await assets.settle();
  assert.deepEqual(saved?.folders, ["More unsaved changes", "Unpublished changes"]);
  assert.equal(assets.saveState().status, "saved");
});

test("background save failures remain handled without hiding failures from settle", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  let failure: Error | undefined = new Error("disk is full");
  let saved: Manifest | undefined;
  const assets = library(t, async (manifest) => {
    if (failure) throw failure;
    saved = manifest;
  });
  assets.createFolder("Keep this folder");
  await assets.flush();
  assert.equal(log.mock.callCount(), 1);
  assert.deepEqual(assets.saveState(), { status: "failed", error: "disk is full" });
  await assert.rejects(assets.settle(), failure);
  failure = undefined;
  await assets.settle();
  assert.deepEqual(saved?.folders, ["Keep this folder"]);
});

test("settle drains serialized saves that arrive while an earlier save is pending", async (t) => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const firstStarted = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  let calls = 0;
  let saved: Manifest | undefined;
  const assets = library(t, async (manifest) => {
    calls++;
    if (calls === 1) {
      firstStarted.resolve();
      await first.promise;
    } else {
      secondStarted.resolve();
      await second.promise;
    }
    saved = manifest;
  });
  try {
    assets.createFolder("First");
    let settled = false;
    const saving = assets.settle().then(() => { settled = true; });
    await firstStarted.promise;
    assets.createFolder("Second");
    const alsoSaving = assets.settle();
    assert.equal(calls, 1);
    first.resolve();
    await secondStarted.promise;
    assert.equal(settled, false);
    assert.equal(assets.saveState().status, "saving");
    second.resolve();
    await Promise.all([saving, alsoSaving]);
    assert.deepEqual(saved?.folders, ["First", "Second"]);
    assert.equal(assets.saveState().status, "saved");
  } finally {
    first.resolve();
    second.resolve();
  }
});

test("a successful queued save clears an earlier failure without leaving phantom unsaved changes", async (t) => {
  t.mock.method(console, "error", () => {});
  const first = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  let calls = 0;
  let saved: Manifest | undefined;
  const assets = library(t, async (manifest) => {
    if (++calls === 1) { started.resolve(); await first.promise; }
    saved = manifest;
  });
  assets.createFolder("First");
  const firstSave = assets.flush();
  await started.promise;
  assets.createFolder("Second");
  const secondSave = assets.flush();
  first.reject(new Error("temporary failure"));
  await Promise.all([firstSave, secondSave]);
  assert.deepEqual(saved?.folders, ["First", "Second"]);
  assert.equal(assets.saveState().status, "saved");
  await assets.settle();
  assert.equal(calls, 2);
});
