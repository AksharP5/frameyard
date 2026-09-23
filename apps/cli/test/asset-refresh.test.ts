import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import type { ProjectFS } from "../../../packages/assets/src/fs.ts";
import type { Manifest } from "../../../packages/assets/src/manifest.ts";

// Bundle extensionless browser imports so Node exercises the real library.
const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../../../packages/assets/src/library.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "node",
});
const { AssetLibrary } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`) as typeof import("../../../packages/assets/src/library.ts");

test("replacing bytes at the same asset path rebinds live clips and records the new identity", async () => {
  let file = new File(['[{"text":"first render"}]'], "captions.json", { type: "application/json", lastModified: 1 });
  let manifest: Manifest = { version: 1, folders: [], assets: [] };
  const fs: ProjectFS = {
    async readManifest() { return manifest; },
    async writeManifest(value) { manifest = value; },
    async list() { return []; },
    async stat() { return { size: file.size, mtime: file.lastModified }; },
    async file() { return file; },
    async write() {},
    async remove() {},
  };
  const clip = { assetId: "", start: 4, sourceIn: 1, sourceOut: 3 };
  const relinks: string[] = [];
  const library = new AssetLibrary(fs, { onRelink(asset, from) {
    relinks.push(from);
    if (clip.assetId === from) clip.assetId = asset.id;
  } });
  try {
    const { assets: [original] } = await library.import(["assets/captions.json"]);
    clip.assetId = original.id;
    await library.flush();
    const originalFile = file;
    const originalManifest = structuredClone(manifest);
    file = new File(['[{"text":"second render"}]'], "captions.json", { type: "application/json", lastModified: 2 });
    await library.load();
    await library.flush();
    assert.notEqual(clip.assetId, original.id);
    assert.equal(library.get("captions.json")?.id, clip.assetId);
    assert.equal(manifest.assets[0].id, clip.assetId);
    assert.deepEqual(clip, { assetId: manifest.assets[0].id, start: 4, sourceIn: 1, sourceOut: 3 });
    await library.load();
    assert.deepEqual(relinks, [original.id]);
    file = new File([file], "captions.json", { type: "application/json", lastModified: 3 });
    await library.load();
    await library.flush();
    assert.equal(manifest.assets[0].stat?.mtime, 3);
    assert.deepEqual(relinks, [original.id]);
    const regeneratedId = clip.assetId;
    file = originalFile;
    manifest = originalManifest;
    await library.load();
    assert.equal(clip.assetId, original.id, 'restoring manifest and media reconnects the live clip without a source remount');
    assert.deepEqual(relinks, [original.id, regeneratedId]);
  } finally {
    await library.dispose();
  }
});

test("moving identical bytes refreshes live source handles and leaves failed manifest saves retryable", async () => {
  const originalSource = "/old/captions.json", replacementSource = "assets/collected/captions.json";
  const files = new Map([
    [originalSource, new File(['[{"text":"same captions"}]'], "captions.json", { type: "application/json", lastModified: 1 })],
    [replacementSource, new File(['[{"text":"same captions"}]'], "captions.json", { type: "application/json", lastModified: 2 })],
  ]);
  let manifest: Manifest = { version: 1, folders: [], assets: [] };
  let failSave = false;
  const fs: ProjectFS = {
    async readManifest() { return manifest; },
    async writeManifest(value) {
      if (failSave) throw new Error("manifest is not writable");
      manifest = value;
    },
    async list() { return []; },
    async stat(source) {
      const file = files.get(source);
      return file ? { size: file.size, mtime: file.lastModified } : null;
    },
    async file(source) {
      const file = files.get(source);
      if (!file) throw new Error(`Missing source: ${source}`);
      return file;
    },
    async write() {},
    async remove() {},
  };
  const clip = { assetId: "", source: originalSource, failed: true, start: 4, sourceIn: 1, sourceOut: 3 };
  const relinks: { from: string; source: string }[] = [];
  const library = new AssetLibrary(fs, { onRelink(asset, from) {
    relinks.push({ from, source: asset.source });
    if (clip.assetId !== from) return;
    clip.assetId = asset.id;
    clip.source = asset.source;
    clip.failed = false;
  } });
  try {
    const { assets: [original] } = await library.import([originalSource]);
    clip.assetId = original.id;
    await library.settle();
    files.delete(originalSource);
    failSave = true;
    const relinked = await library.relink(original, replacementSource);
    assert.equal(relinked, original);
    assert.deepEqual(relinks, [{ from: original.id, source: replacementSource }]);
    assert.deepEqual(clip, { assetId: original.id, source: replacementSource, failed: false, start: 4, sourceIn: 1, sourceOut: 3 });
    assert.equal(await (await relinked.handle.getFile()).text(), '[{"text":"same captions"}]');
    await assert.rejects(library.settle(), /manifest is not writable/);
    assert.equal(manifest.assets[0].source, originalSource);
    failSave = false;
    await library.settle();
    assert.equal(manifest.assets[0].source, replacementSource);
    assert.equal(manifest.assets[0].id, original.id);
    assert.equal(relinks.length, 1);
  } finally { failSave = false; await library.dispose(); }
});

test("same-size regenerated sequence frames invalidate their previous identity", async () => {
  const { hashSequence } = await import("../../../packages/assets/src/hash.ts");
  const before = [{ name: "frame0001.png", size: 100, mtime: 1 }, { name: "frame0002.png", size: 100, mtime: 1 }];
  const original = await hashSequence(before);
  assert.equal(await hashSequence(before), original);
  assert.notEqual(await hashSequence(before.map((frame) => ({ ...frame, mtime: 2 }))), original);
});

test("sequence frame rate survives import and reopen, and metadata-only edits refresh playback", async (t) => {
  const bitmap = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: async (file: File) => {
    assert.match(file.name, /^frame\d+\.png$/);
    return { width: 1920, height: 1080, close() {} };
  } });
  t.after(() => { if (bitmap) Object.defineProperty(globalThis, "createImageBitmap", bitmap); else Reflect.deleteProperty(globalThis, "createImageBitmap"); });
  const source = "assets/title.frames";
  let directoryMtime = 0;
  const files = new Map(Array.from({ length: 60 }, (_, index) => {
    const name = `frame${String(index).padStart(4, "0")}.png`;
    return [name, new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])], name, { type: "image/png", lastModified: 1 })];
  }));
  const setMetadata = (value: unknown) => files.set(".sequence.json", new File([JSON.stringify(value)], ".sequence.json", { lastModified: ++directoryMtime }));
  setMetadata({ frameRate: 60 });
  let manifest: Manifest = { version: 1, folders: [], assets: [] };
  const fs: ProjectFS = {
    async readManifest() { return manifest; },
    async writeManifest(value) { manifest = value; },
    async list(path) {
      return path === source ? [...files].map(([name, file]) => ({ name, kind: "file", size: file.size, mtime: file.lastModified })) : [];
    },
    async stat(path) {
      if (path === source) return { size: 0, mtime: directoryMtime };
      const file = files.get(path.slice(source.length + 1));
      return file ? { size: file.size, mtime: file.lastModified } : null;
    },
    async file(path) {
      const file = files.get(path.slice(source.length + 1));
      if (!file) throw new Error(`Missing ${path}`);
      return file;
    },
    async write() {}, async remove() {},
  };
  const relinks: string[] = [];
  const library = new AssetLibrary(fs, { onRelink: (_asset, from) => { relinks.push(from); } });
  try {
    const imported = await library.import([source]);
    assert.deepEqual(imported.failed, []);
    const original = imported.assets[0];
    assert.equal(original.type, "SEQUENCE");
    if (original.type !== "SEQUENCE") return;
    assert.equal(original.frameRate, 60);
    assert.equal(original.duration, 1);
    await library.settle();
    await library.load();
    assert.equal((await library.get("title.frames")!.handle.getFile()).name, "frame0000.png");
    setMetadata({ frameRate: 30 });
    await library.load();
    await library.settle();
    const revised = library.get("title.frames")!;
    assert.equal(revised.type, "SEQUENCE");
    if (revised.type !== "SEQUENCE") return;
    assert.equal(revised.duration, 2);
    assert.equal(revised.frameRate, 30);
    assert.notEqual(revised.id, original.id);
    assert.deepEqual(relinks, [original.id]);
    files.delete(".sequence.json");
    directoryMtime++;
    await library.load();
    const legacy = library.get("title.frames")!;
    assert.equal(legacy.type, "SEQUENCE");
    if (legacy.type !== "SEQUENCE") return;
    assert.equal(legacy.frameRate, 30);
    const { hashSequence } = await import("../../../packages/assets/src/hash.ts");
    assert.equal(legacy.id, await hashSequence(await fs.list(source)));
  } finally { await library.dispose(); }
});
