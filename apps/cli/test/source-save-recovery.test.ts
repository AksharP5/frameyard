import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";
import { watch } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { ProjectChanges } from "../../desktop/src/project-changes.ts";
import type { SourceEdit } from "../../desktop/src/edit.ts";

const built = await build({
  entryPoints: [fileURLToPath(new URL("../../desktop/src/edit.ts", import.meta.url))],
  bundle: true, write: false, format: "cjs", platform: "node", external: ["ts-morph"],
});

function sourceWriter(failRename: (target: string) => boolean = () => false, afterStage?: () => Promise<void>) {
  const module = { exports: {} as Pick<typeof import("../../desktop/src/edit.ts"), "applyEdits" | "stampProject"> };
  const require = createRequire(import.meta.url);
  runInThisContext(`(function(require,module,exports){${built.outputFiles[0].text}\n})`)(
    (name: string) => name === "node:fs/promises" ? {
      ...fs,
      writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
        await fs.writeFile(...args);
        await afterStage?.();
      },
      rename: async (source: string, target: string) => {
        if (failRename(target)) throw new Error("disk is full");
        return fs.rename(source, target);
      },
    } : require(name), module, module.exports,
  );
  return Object.assign(module.exports.applyEdits, { stampProject: module.exports.stampProject });
}

test("atomic source saves do not reload the editor and subsequent external edits do", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "source-save-watch-"));
  const file = join(dir, "index.tsx");
  await fs.writeFile(file, 'export default () => <scene id="scene" />;');
  const events: string[] = [];
  const changes = new ProjectChanges(dir, path => events.push(path), 100);
  const watcher = watch(dir, (_event, path) => { if (path) changes.changed(path); });
  t.after(async () => {
    watcher.close();
    changes.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const result = await sourceWriter()({ dir, onWrite: (path, text) => changes.mark(path, text) }, [
    { kind: "insert", source: "pending#clip", parent: "index.tsx:scene", tag: "rect", props: { x: 10 } },
  ]);
  assert.deepEqual(result.remaining, []);
  await setTimeout(180);
  assert.deepEqual(events, []);
  await fs.writeFile(file, 'export default () => <scene id="scene" background="blue" />;');
  await setTimeout(60);
  assert.ok(events.length > 0);
  assert.ok(events.every(path => path === "index.tsx"));
});

test("partial file failure retains only uncommitted edits and leaves the failed original intact", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "source-save-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const initial = 'export default () => <scene id="scene" />;';
  await Promise.all(["first.tsx", "second.tsx"].map(file => fs.writeFile(join(dir, file), initial, { mode: 0o640 })));
  let failed = true;
  const apply = sourceWriter(target => failed && target.endsWith("second.tsx"));
  const edits: SourceEdit[] = [
    { kind: "insert", source: "pending#first", parent: "first.tsx:scene", tag: "rect", props: { x: 1 } },
    { kind: "insert", source: "pending#second", parent: "second.tsx:scene", tag: "rect", props: { x: 2 } },
  ];
  const result = await apply({ dir }, edits);
  assert.match(result.error!, /second.tsx: disk is full/);
  assert.ok(result.ids?.["pending#first"]);
  assert.equal(result.ids?.["pending#second"], undefined);
  assert.deepEqual(result.remaining, [edits[1]]);
  assert.equal(await fs.readFile(join(dir, "second.tsx"), "utf8"), initial);
  assert.deepEqual((await fs.readdir(dir)).sort(), ["first.tsx", "second.tsx"]);
  failed = false;
  const retried = await apply({ dir }, result.remaining!);
  assert.deepEqual(retried.remaining, []);
  assert.equal((await fs.readFile(join(dir, "first.tsx"), "utf8")).match(/<rect/g)?.length, 1);
  assert.equal((await fs.readFile(join(dir, "second.tsx"), "utf8")).match(/<rect/g)?.length, 1);
  assert.equal((await fs.stat(join(dir, "first.tsx"))).mode & 0o777, 0o640);
});

test("a refused set after a successful insert never includes that insert in a retry", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "source-save-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(join(dir, "index.tsx"), 'export default () => <scene id="scene" />;');
  const result = await sourceWriter()({ dir }, [
    { kind: "insert", source: "pending#clip", parent: "index.tsx:scene", tag: "rect", props: { x: 0 } },
    { kind: "set", source: "pending#clip", props: { x: 20 }, text: "not a text element" },
  ]);
  assert.deepEqual(result.remaining, [{ kind: "set", source: result.ids!["pending#clip"], props: {}, text: "not a text element" }]);
  assert.match(await fs.readFile(join(dir, "index.tsx"), "utf8"), /x=\{20\}/);
});

test("a source changed while staging is preserved and pending edits can retry against the new text", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "source-save-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const path = join(dir, "index.tsx"), initial = 'export default () => <scene id="scene" />;';
  const concurrent = 'export default () => <scene id="scene" background="blue" />;';
  await fs.writeFile(path, initial);
  const edits: SourceEdit[] = [{ kind: "insert", source: "pending#clip", parent: "index.tsx:scene", tag: "rect", props: { x: 10 } }];
  const failed = await sourceWriter(undefined, () => fs.writeFile(path, concurrent))({ dir }, edits);
  assert.match(failed.error!, /source changed during saving/);
  assert.deepEqual(failed.remaining, edits);
  assert.equal(failed.ids, undefined);
  assert.equal(await fs.readFile(path, "utf8"), concurrent);
  assert.deepEqual(await fs.readdir(dir), ["index.tsx"]);
  const retried = await sourceWriter()({ dir }, failed.remaining!);
  assert.deepEqual(retried.remaining, []);
  const saved = await fs.readFile(path, "utf8");
  assert.match(saved, /background="blue"/);
  assert.equal(saved.match(/<rect/g)?.length, 1);
});

test("undoing a split acknowledges a child already removed with its sequence", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "source-split-undo-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const path = join(dir, "index.tsx");
  await fs.writeFile(path, 'export default () => <scene id="scene"><rect id="first" start={1} end={3} /><rect id="second" start={3} end={6} /></scene>;');
  const apply = sourceWriter();
  const split = await apply({ dir }, [
    { kind: "insert", source: "pending#sequence", parent: "index.tsx:scene", tag: "sequence", props: {}, before: "index.tsx:second" },
    { kind: "insert", source: "pending#child", parent: "pending#sequence", tag: "rect", props: { start: 2, end: 3 } },
    { kind: "move", source: "index.tsx:first", parent: "pending#sequence", before: "pending#child" },
  ]);
  assert.deepEqual(split.remaining, []);
  const undo = await apply({ dir }, [
    { kind: "move", source: "index.tsx:first", parent: "index.tsx:scene", before: "index.tsx:second" },
    { kind: "set", source: "index.tsx:first", props: { end: 3 } },
    { kind: "remove", source: split.ids!["pending#sequence"] },
    { kind: "remove", source: split.ids!["pending#child"] },
  ]);
  assert.deepEqual(undo.skipped, []);
  assert.deepEqual(undo.remaining, []);
  const saved = await fs.readFile(path, "utf8");
  assert.equal(saved.match(/<rect/g)?.length, 2);
  assert.match(saved, /id="first"/);
  assert.doesNotMatch(saved, /<sequence/);
  const stale = { kind: "remove", source: split.ids!["pending#child"] } as const;
  assert.deepEqual((await apply({ dir }, [stale])).remaining, [stale], "removal evidence must not carry into later writes");
});

test("removing a parent does not acknowledge unrelated missing targets", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "source-remove-missing-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(join(dir, "index.tsx"), 'export default () => <scene id="scene"><sequence id="group"><rect id="child" /></sequence></scene>;');
  const missing = { kind: "remove", source: "index.tsx:missing" } as const;
  const result = await sourceWriter()({ dir }, [
    { kind: "remove", source: "index.tsx:group" },
    { kind: "remove", source: "index.tsx:child" },
    missing,
  ]);
  assert.deepEqual(result.skipped, [missing.source]);
  assert.deepEqual(result.remaining, [missing]);
});

test("concurrent source edits and stamping serialize across folder aliases without blocking other projects", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "source-concurrent-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = join(root, "project"), other = join(root, "other"), alias = join(root, "alias");
  await fs.mkdir(dir);
  await fs.mkdir(other);
  await fs.symlink(dir, alias, "dir");
  const initial = 'export default () => <scene id="scene"><rect id="rect" x={0} y={0} /><rect /></scene>;';
  await fs.writeFile(join(dir, "index.tsx"), initial);
  await fs.writeFile(join(other, "index.tsx"), initial);
  const staged = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let stages = 0;
  const apply = sourceWriter(undefined, async () => {
    if (++stages !== 1) return;
    staged.resolve();
    await release.promise;
  });
  const first = apply({ dir }, [{ kind: "set", source: "index.tsx:rect", props: { x: 10 } }]);
  await staged.promise;
  let edited = false, stamped = false;
  const second = apply({ dir: alias }, [{ kind: "set", source: "index.tsx:rect", props: { y: 20 } }]).then(result => { edited = true; return result; });
  const stamping = apply.stampProject({ dir }).then(() => { stamped = true; });
  try {
    const independent = await apply({ dir: other }, [{ kind: "set", source: "index.tsx:rect", props: { x: 50 } }]);
    assert.deepEqual(independent.remaining, []);
    assert.equal(edited, false);
    assert.equal(stamped, false);
  } finally { release.resolve(); }
  const [a, b] = await Promise.all([first, second, stamping]);
  assert.deepEqual(a.remaining, []);
  assert.deepEqual(b.remaining, []);
  const saved = await fs.readFile(join(dir, "index.tsx"), "utf8");
  assert.match(saved, /x=\{10\}/);
  assert.match(saved, /y=\{20\}/);
  assert.equal(saved.match(/id="/g)?.length, 3);
  assert.deepEqual(await fs.readdir(dir), ["index.tsx"]);
});
