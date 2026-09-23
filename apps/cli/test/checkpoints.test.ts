import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";

const built = await build({
  entryPoints: [fileURLToPath(new URL("../../desktop/src/checkpoints.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", write: false,
});
const require = createRequire(import.meta.url);

function loadCheckpoints(copyFile: typeof fs.copyFile = fs.copyFile) {
  const module = { exports: {} as typeof import("../../desktop/src/checkpoints.ts") };
  runInThisContext(`(function(require,module,exports){${built.outputFiles[0].text}\n})`)(
    (name: string) => name === "node:fs/promises" ? { ...fs, copyFile } : require(name), module, module.exports,
  );
  return module.exports;
}
const { createCheckpoint, createRecoveryCheckpoint, listCheckpoints, restoreCheckpoint } = loadCheckpoints();

async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(join(tmpdir(), "diffusion-checkpoints-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const put = async (path: string, content: string | Buffer) => {
    await fs.mkdir(dirname(join(dir, path)), { recursive: true });
    await fs.writeFile(join(dir, path), content);
  };
  return { dir, put, read: (path: string) => fs.readFile(join(dir, path), "utf8") };
}

test("restores source, retained animation inputs, and rendered assets with a recoverable current state", async (t) => {
  const f = await fixture(t);
  const original = {
    "index.tsx": "original timeline",
    "package.json": '{"diffusion":{"animations":{}}}',
    "animations/diagram/scene.py": "class Original(Scene): pass",
    "assets/diagram.mp4": "original rendered video",
    "assets/diagram.frames/0001.png": "original frame",
    "removed.tsx": "restore this source",
  };
  for (const [path, content] of Object.entries(original)) await f.put(path, content);
  const excluded = [".diffusion/session.json", ".git/index", "node_modules/module.js", "animations/.venv/python", "animations/venv/python", "animations/__pycache__/scene.pyc", ".cache/work", "assets/.animation-work/media/partial.mp4"];
  for (const path of excluded) await f.put(path, "private or temporary before");
  const before = await createCheckpoint(f.dir, "  Before agent edit  ");
  assert.equal(before.label, "Before agent edit");
  assert.equal(before.fileCount, Object.keys(original).length);
  assert.equal(before.bytes, Object.values(original).reduce((sum, value) => sum + Buffer.byteLength(value), 0));
  assert.deepEqual(await listCheckpoints(f.dir), [before]);

  await f.put("index.tsx", "agent timeline");
  await f.put("animations/diagram/scene.py", "class Agent(Scene): pass");
  await f.put("assets/diagram.mp4", "agent rendered video");
  await f.put("assets/diagram.frames/0001.png", "agent frame");
  await fs.rm(join(f.dir, "removed.tsx"));
  await f.put("new/nested/agent.tsx", "new source");
  for (const path of excluded) await f.put(path, "private or temporary after");

  const result = await restoreCheckpoint(f.dir, before.id);
  assert.deepEqual(result.restored, before);
  assert.match(result.recovery.label, /Before restoring Before agent edit/);
  for (const [path, content] of Object.entries(original)) assert.equal(await f.read(path), content);
  await assert.rejects(f.read("new/nested/agent.tsx"), { code: "ENOENT" });
  for (const path of excluded) assert.equal(await f.read(path), "private or temporary after");

  await restoreCheckpoint(f.dir, result.recovery.id);
  assert.equal(await f.read("index.tsx"), "agent timeline");
  assert.equal(await f.read("animations/diagram/scene.py"), "class Agent(Scene): pass");
  assert.equal(await f.read("assets/diagram.mp4"), "agent rendered video");
  assert.equal(await f.read("assets/diagram.frames/0001.png"), "agent frame");
  assert.equal(await f.read("new/nested/agent.tsx"), "new source");
  await assert.rejects(f.read("removed.tsx"), { code: "ENOENT" });
  assert.equal((await listCheckpoints(f.dir)).length, 3);
});

test("unchanged media shares snapshot storage without sharing writable live files", async (t) => {
  const f = await fixture(t);
  await f.put("index.tsx", "one");
  await f.put("assets/video.mp4", Buffer.alloc(1024 * 1024, 42));
  const first = await createCheckpoint(f.dir, "First");
  await f.put("index.tsx", "two");
  const [second, third] = await Promise.all([createCheckpoint(f.dir, "Second"), createCheckpoint(f.dir, "Third")]);
  const stored = (id: string, path: string) => join(f.dir, ".diffusion/checkpoints", id, "files", path);
  const one = await fs.stat(stored(first.id, "assets/video.mp4"));
  const two = await fs.stat(stored(second.id, "assets/video.mp4"));
  const live = await fs.stat(join(f.dir, "assets/video.mp4"));
  assert.equal(one.ino, two.ino);
  assert.notEqual(one.ino, live.ino);
  assert.equal((await fs.stat(stored(third.id, "assets/video.mp4"))).ino, one.ino);
  await f.put("assets/video.mp4", "changed media");
  assert.equal((await fs.readFile(stored(first.id, "assets/video.mp4"))).length, 1024 * 1024);
  assert.equal(await fs.readFile(stored(first.id, "index.tsx"), "utf8"), "one");
  assert.equal(await fs.readFile(stored(second.id, "index.tsx"), "utf8"), "two");
  assert.equal((await listCheckpoints(f.dir)).length, 3);
});

test("restores file and nested-directory replacements, and rejects conflicts with preserved data", async (t) => {
  const f = await fixture(t);
  await f.put("shape", "original file");
  await f.put("other/deep/source.tsx", "original nested source");
  const before = await createCheckpoint(f.dir, "Original shape");
  await fs.rm(join(f.dir, "shape"));
  await f.put("shape/deep/nested/new.tsx", "new nested source");
  await fs.rm(join(f.dir, "other"), { recursive: true });
  await f.put("other", "new file");
  const { recovery } = await restoreCheckpoint(f.dir, before.id);
  assert.equal(await f.read("shape"), "original file");
  assert.equal(await f.read("other/deep/source.tsx"), "original nested source");
  await restoreCheckpoint(f.dir, recovery.id);
  assert.equal(await f.read("shape/deep/nested/new.tsx"), "new nested source");
  assert.equal(await f.read("other"), "new file");

  await f.put("shape/.git/config", "preserved repository");
  const count = (await listCheckpoints(f.dir)).length;
  await assert.rejects(restoreCheckpoint(f.dir, before.id), /excluded data/);
  assert.equal(await f.read("other"), "new file");
  assert.equal(await f.read("shape/.git/config"), "preserved repository");
  assert.equal((await listCheckpoints(f.dir)).length, count);
});

test("failed capture publishes nothing; failed restore reports a usable recovery checkpoint", async (t) => {
  const f = await fixture(t);
  await f.put("index.tsx", "original");
  let failure: "capture" | "restore" | undefined;
  const checkpoints = loadCheckpoints(async (source, destination, mode) => {
    if (failure === "capture" || (failure === "restore" && destination === join(f.dir, "index.tsx"))) {
      throw new Error("simulated disk failure");
    }
    return fs.copyFile(source, destination, mode);
  });
  failure = "capture";
  await assert.rejects(checkpoints.createCheckpoint(f.dir, "Broken"), /simulated disk failure/);
  assert.deepEqual(await listCheckpoints(f.dir), []);
  assert.deepEqual(await fs.readdir(join(f.dir, ".diffusion/checkpoints")), []);
  assert.equal(await f.read("index.tsx"), "original");

  failure = undefined;
  const before = await checkpoints.createCheckpoint(f.dir, "Before");
  await f.put("index.tsx", "current work");
  await f.put("assets/new.mp4", "current render");
  failure = "restore";
  let recoveryId: string | undefined;
  await assert.rejects(checkpoints.restoreCheckpoint(f.dir, before.id), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /simulated disk failure/);
    recoveryId = /preserved in checkpoint ([\da-f-]+)\./.exec(error.message)?.[1];
    assert.ok(recoveryId);
    return true;
  });
  const recovery = (await listCheckpoints(f.dir)).find(item => item.id === recoveryId);
  assert.ok(recovery);
  assert.equal(recovery.fileCount, 2);
  failure = undefined;
  await checkpoints.restoreCheckpoint(f.dir, recovery.id);
  assert.equal(await f.read("index.tsx"), "current work");
  assert.equal(await f.read("assets/new.mp4"), "current render");
});

test("rejects unsafe or inconsistent manifests and damaged files before changing the project", async (t) => {
  const f = await fixture(t);
  await f.put("index.tsx", "original");
  const before = await createCheckpoint(f.dir, "Before");
  const snapshot = join(f.dir, ".diffusion/checkpoints", before.id);
  const manifestPath = join(snapshot, "manifest.json");
  const validManifest = await fs.readFile(manifestPath, "utf8");
  await f.put("index.tsx", "current");
  for (const path of ["../escaped.tsx", "/escaped.tsx", ".diffusion/session.json", "node_modules/package.js", "a/../../escaped.tsx", "a\\escaped.tsx"]) {
    await fs.writeFile(manifestPath, JSON.stringify({ ...before, bytes: 1, files: [{ path, size: 1, mtime: 0, ctime: 0, mode: 0o644 }] }));
    await assert.rejects(restoreCheckpoint(f.dir, before.id));
    assert.equal(await f.read("index.tsx"), "current");
  }
  for (const paths of [["a", "a/child"], ["a", "a"]]) {
    await fs.writeFile(manifestPath, JSON.stringify({ ...before, fileCount: 2, bytes: 2, files: paths.map(path => ({ path, size: 1, mtime: 0, ctime: 0, mode: 0o644 })) }));
    await assert.rejects(restoreCheckpoint(f.dir, before.id));
  }
  await fs.writeFile(manifestPath, validManifest);
  await fs.writeFile(join(snapshot, "files/index.tsx"), "damaged snapshot");
  await assert.rejects(restoreCheckpoint(f.dir, before.id), /damaged checkpoint file/);
  await assert.rejects(restoreCheckpoint(f.dir, "../../outside"));
  assert.equal(await f.read("index.tsx"), "current");
  assert.equal((await listCheckpoints(f.dir)).length, 1);
});

test("ignores project symlinks and refuses symlinks in restore destinations or checkpoint storage", async (t) => {
  const f = await fixture(t);
  const outside = await fixture(t);
  await outside.put("index.tsx", "outside source");
  await f.put("index.tsx", "original source");
  await fs.symlink(outside.dir, join(f.dir, "linked"));
  const before = await createCheckpoint(f.dir, "Before");
  assert.equal(before.fileCount, 1);
  await fs.rm(join(f.dir, "index.tsx"));
  await fs.symlink(join(outside.dir, "index.tsx"), join(f.dir, "index.tsx"));
  await assert.rejects(restoreCheckpoint(f.dir, before.id), /symbolic link/);
  assert.equal(await outside.read("index.tsx"), "outside source");
  await fs.rm(join(f.dir, "index.tsx"));
  await f.put("index.tsx", "current source");

  const stored = join(f.dir, ".diffusion/checkpoints", before.id, "files/index.tsx");
  await fs.rm(stored);
  await fs.symlink(join(outside.dir, "index.tsx"), stored);
  await assert.rejects(restoreCheckpoint(f.dir, before.id), /symbolic link/);
  assert.equal(await f.read("index.tsx"), "current source");
  assert.equal(await outside.read("index.tsx"), "outside source");

  const unsafe = await fixture(t);
  await fs.symlink(outside.dir, join(unsafe.dir, ".diffusion"));
  await assert.rejects(createCheckpoint(unsafe.dir, "Unsafe"), /Unsafe checkpoint directory/);
  await assert.rejects(fs.access(join(outside.dir, "checkpoints")), { code: "ENOENT" });
});


test("automatic recoveries keep ten versions and preserve every manual checkpoint", async (t) => {
  const f = await fixture(t);
  await f.put("index.tsx", "manual source");
  const manual = await createCheckpoint(f.dir, "Automatic recovery");
  const versions: string[] = [];
  for (let version = 0; version < 12; version++) {
    await f.put("index.tsx", `version ${version}`);
    versions.push((await createRecoveryCheckpoint(f.dir)).id);
  }
  const saved = await listCheckpoints(f.dir);
  assert.equal(saved.filter(item => item.automatic).length, 10);
  assert.ok(saved.some(item => item.id === manual.id && !item.automatic));
  assert.ok(!saved.some(item => versions.slice(0, 2).includes(item.id)));
  await restoreCheckpoint(f.dir, versions[2]!);
  assert.equal(await f.read("index.tsx"), "version 2");
  await restoreCheckpoint(f.dir, manual.id);
  assert.equal(await f.read("index.tsx"), "manual source");
});


test("automatic recovery retains an unresolved journal without applying it to saved source", async (t) => {
  const f = await fixture(t);
  await f.put("index.tsx", "saved source");
  const editorRecovery = { journal: '{"interrupted":', saveErrors: ['Recovered edits need review'] };
  const snapshot = await createRecoveryCheckpoint(f.dir, editorRecovery);
  const recoveryPath = `.diffusion/checkpoints/${snapshot.id}/editor-recovery.json`;
  assert.deepEqual(JSON.parse(await f.read(recoveryPath)), editorRecovery);
  assert.equal(await f.read(`.diffusion/checkpoints/${snapshot.id}/files/index.tsx`), "saved source");
  assert.equal(await f.read("index.tsx"), "saved source");
  await f.put("index.tsx", "later source");
  await restoreCheckpoint(f.dir, snapshot.id);
  assert.equal(await f.read("index.tsx"), "saved source");
  assert.deepEqual(JSON.parse(await f.read(recoveryPath)), editorRecovery);
});
