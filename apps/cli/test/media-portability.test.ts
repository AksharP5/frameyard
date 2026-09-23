import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";
import { collectMediaSources, findMissingMedia } from "../../desktop/src/media-portability.ts";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "studio-portability-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = join(root, "project"), external = join(root, "external");
  await Promise.all([fs.mkdir(project), fs.mkdir(external)]);
  return { root, project, external };
}

const built = await build({
  entryPoints: [fileURLToPath(new URL("../../desktop/src/media-portability.ts", import.meta.url))],
  bundle: true, write: false, format: "cjs", platform: "node", external: ["zod"],
});

function collector(overrides: Partial<Pick<typeof fs, "copyFile" | "rm">>) {
  const module = { exports: {} as { collectMediaSources: typeof collectMediaSources } };
  const require = createRequire(import.meta.url);
  runInThisContext(`(function(require,module,exports){${built.outputFiles[0].text}\n})`)(
    (name: string) => name === "node:fs/promises" ? { ...fs, ...overrides } : require(name), module, module.exports,
  );
  return module.exports.collectMediaSources;
}

test("missing-media search checks basename and expected size without traversing symbolic links", async (t) => {
  const { project, external } = await fixture(t);
  const first = join(project, "first"), second = join(project, "second"), frames = join(project, "frames");
  await Promise.all([fs.mkdir(first), fs.mkdir(second), fs.mkdir(frames)]);
  await Promise.all([
    fs.writeFile(join(first, "clip.mov"), "right"), fs.writeFile(join(second, "clip.mov"), "wrong-size"),
    fs.writeFile(join(external, "clip.mov"), "right"), fs.symlink(external, join(project, "linked-folder")),
    fs.symlink(join(external, "clip.mov"), join(frames, "clip.mov")),
  ]);
  const result = await findMissingMedia({ folder: project, missing: [
    { source: "C:\\old\\clip.mov", size: 5 }, { source: "/old/clip.mov" },
    { source: "/old/frames" }, { source: "https://example.test/clip.mov" },
  ] });
  assert.deepEqual(result.map(item => item.candidates), [
    [join(first, "clip.mov")], [join(first, "clip.mov"), join(second, "clip.mov")], [frames], [],
  ]);
});

test("collection copies files and nested frame folders byte-for-byte with unique relative paths", async (t) => {
  const { root, project, external } = await fixture(t);
  const another = join(root, "another"), frames = join(external, "frames"), nested = join(frames, "nested");
  await Promise.all([fs.mkdir(another), fs.mkdir(nested, { recursive: true })]);
  const first = join(external, "clip.mov"), second = join(another, "clip.mov"), alias = join(external, "alias.mov");
  const bytes = Buffer.from([0, 255, 1, 128, 0, 5, 0]);
  await Promise.all([
    fs.writeFile(first, bytes), fs.writeFile(second, "second source"), fs.symlink(first, alias),
    fs.writeFile(join(frames, "001.exr"), bytes), fs.writeFile(join(nested, "002.exr"), "second frame"),
    fs.writeFile(join(frames, ".metadata"), "metadata"),
  ]);
  const result = await collectMediaSources({ dir: project, sources: [first, second, alias, frames] });
  assert.deepEqual(result.failed, []);
  assert.equal(result.copies.length, 4);
  assert.equal(basename(result.copies[0]!.path), "clip.mov");
  assert.equal(basename(result.copies[1]!.path), "clip-2.mov");
  assert.equal(result.copies[2]!.path, result.copies[0]!.path);
  for (const copy of result.copies) assert.match(copy.path, /^assets\/collected\/[^/]+\//);
  assert.deepEqual(await fs.readFile(join(project, result.copies[0]!.path)), bytes);
  assert.equal(await fs.readFile(join(project, result.copies[1]!.path), "utf8"), "second source");
  const collectedFrames = join(project, result.copies[3]!.path);
  assert.deepEqual(await fs.readFile(join(collectedFrames, "001.exr")), bytes);
  assert.equal(await fs.readFile(join(collectedFrames, "nested", "002.exr"), "utf8"), "second frame");
  assert.equal(await fs.readFile(join(collectedFrames, ".metadata"), "utf8"), "metadata");
  assert.deepEqual(await fs.readFile(first), bytes);
  assert.deepEqual(await fs.readFile(join(frames, "001.exr")), bytes);
  const batch = join(project, result.copies[0]!.path, "..");
  assert.deepEqual((await fs.readdir(batch)).sort(), ["clip-2.mov", "clip.mov", "frames"]);
});

test("contained media stays in place while linked external files become physical project copies", async (t) => {
  const { project, external } = await fixture(t);
  const outside = join(external, "original.mov"), link = join(project, "linked.mov"), frames = join(project, "frames");
  await fs.mkdir(frames);
  await Promise.all([
    fs.writeFile(outside, "source"), fs.writeFile(join(project, "inside.mov"), "inside"),
    fs.symlink(outside, link), fs.symlink(outside, join(frames, "001.exr")),
  ]);
  const result = await collectMediaSources({ dir: project, sources: ["inside.mov", link, frames] });
  assert.deepEqual(result.failed, []);
  assert.equal(result.copies[0]!.path, "inside.mov");
  const collectedFile = join(project, result.copies[1]!.path);
  assert.equal((await fs.lstat(collectedFile)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(collectedFile, "utf8"), "source");
  const collectedFrame = join(project, result.copies[2]!.path, "001.exr");
  assert.equal((await fs.lstat(collectedFrame)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(collectedFrame, "utf8"), "source");
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
});

test("invalid sources and linked destinations report failures without losing earlier successful copies", async (t) => {
  const { root, project, external } = await fixture(t);
  const source = join(external, "source.mov");
  await fs.writeFile(source, "untouched source");
  const result = await collectMediaSources({ dir: project, sources: [source, "../external/source.mov", "https://example.test/source.mov", root, "missing.mov"] });
  assert.equal(result.copies.length, 1);
  assert.equal(result.failed.length, 4);
  assert.match(result.failed[0]!.error, /stay inside the project/);
  assert.match(result.failed[1]!.error, /Remote media URLs/);
  assert.match(result.failed[2]!.error, /contain the project itself/);
  assert.equal(await fs.readFile(join(project, result.copies[0]!.path), "utf8"), "untouched source");
  const another = join(root, "another-project"), destination = join(root, "outside-destination");
  await Promise.all([fs.mkdir(another), fs.mkdir(destination)]);
  await fs.symlink(destination, join(another, "assets"));
  const refused = await collectMediaSources({ dir: another, sources: [source] });
  assert.deepEqual(refused.copies, []);
  assert.match(refused.failed[0]!.error, /without symbolic links/);
  assert.deepEqual(await fs.readdir(destination), []);
  assert.equal(await fs.readFile(source, "utf8"), "untouched source");
});

test("a source changed during copy is refused and its staged copy is removed", async (t) => {
  const { project, external } = await fixture(t);
  const source = join(external, "changing.mov");
  await fs.writeFile(source, "before");
  const collect = collector({ copyFile: async (from, to, mode) => {
    await fs.copyFile(from, to, mode);
    await fs.appendFile(from, " changed");
  } });
  const result = await collect({ dir: project, sources: [source] });
  assert.deepEqual(result.copies, []);
  assert.match(result.failed[0]!.error, /source changed/);
  const batches = await fs.readdir(join(project, "assets", "collected"));
  assert.deepEqual(await fs.readdir(join(project, "assets", "collected", batches[0]!)), []);
  assert.equal(await fs.readFile(source, "utf8"), "before changed");
});

test("staging cleanup failures preserve structured partial results and identify the incomplete copy", async (t) => {
  const { project, external } = await fixture(t);
  const first = join(external, "first.mov"), second = join(external, "second.mov");
  await Promise.all([fs.writeFile(first, "first"), fs.writeFile(second, "second")]);
  const collect = collector({
    copyFile: async (from, to, mode) => {
      await fs.copyFile(from, to, mode);
      if (from === second) throw new Error("copy failed");
    },
    rm: async () => { throw new Error("cleanup failed"); },
  });
  const result = await collect({ dir: project, sources: [first, second] });
  assert.equal(result.copies.length, 1);
  assert.deepEqual(result.failed, [{ source: second, error: "copy failed; could not remove the incomplete copy: cleanup failed" }]);
  assert.equal(await fs.readFile(join(project, result.copies[0]!.path), "utf8"), "first");
  assert.equal(await fs.readFile(second, "utf8"), "second");
});
