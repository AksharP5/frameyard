import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";

const bundled = await build({ entryPoints: [new URL("../../desktop/src/hyperframes-catalog.ts", import.meta.url).pathname], bundle: true, platform: "node", format: "cjs", write: false });
const module = { exports: {} as typeof import("../../desktop/src/hyperframes-catalog") };
runInThisContext(`(function(require,module,exports){${bundled.outputFiles[0].text}\n})`)(createRequire(import.meta.url), module, module.exports);
const { handleCatalogRequest } = module.exports;

const block = {
  name: "test-block", type: "hyperframes:block", title: "Test block", description: "A scene", tags: ["text"],
  dimensions: { width: 640, height: 360 }, duration: 1,
  files: [{ path: "scene.html", target: "compositions/scene.html", type: "hyperframes:composition" }],
};
const component = { name: "test-effect", type: "hyperframes:component", title: "Test effect", description: "An effect", files: [{ path: "effect.html", target: "compositions/components/effect.html", type: "hyperframes:snippet" }] };
const example = { ...block, name: "test-example", type: "hyperframes:example", files: [{ path: "index.html", target: "index.html", type: "hyperframes:composition" }] };

test("catalog includes separately published template previews and keeps browsing available offline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "diffusion-catalog-list-"));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = root;
  t.after(async () => { if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous; await rm(root, { recursive: true, force: true }); });
  const entries = [block, component, example];
  const cacheDirectory = join(root, "diffusion-studio/catalog");
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(join(cacheDirectory, "catalog.json"), JSON.stringify({ fetchedAt: Date.now(), value: [] }));
  await writeFile(join(cacheDirectory, "hyperframes-manifest-v2-example-test-example.json"), JSON.stringify({ fetchedAt: Date.now(), value: { ...example, type: "example" } }));
  let offline = false;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (offline) throw new Error("offline");
    if (url.endsWith("catalog-index.json")) return Response.json(entries.filter((item) => item !== example).map((item) => ({ ...item, type: item.type.split(":")[1] })));
    if (url.endsWith("registry/registry.json")) return Response.json({ items: entries.map(({ name, type }) => ({ name, type })) });
    return Response.json(example);
  });
  const result = await handleCatalogRequest({ action: "list" });
  assert.equal(result.action, "list");
  if (result.action !== "list") return;
  assert.equal(result.items.filter((item) => item.type === "template").length, 8);
  const registryItems = result.items.filter((item) => item.type !== "template");
  assert.deepEqual(registryItems.map((item) => item.type), ["example", "block", "component"]);
  const preview = {
    poster: "https://static.heygen.ai/hyperframes-oss/docs/images/templates/test-example.png",
    video: "https://static.heygen.ai/hyperframes-oss/docs/images/templates/test-example.mp4",
  };
  assert.equal(registryItems[0].poster, preview.poster);
  assert.equal(registryItems[0].video, preview.video);
  const detail = await handleCatalogRequest({ action: "detail", type: "example", name: example.name });
  assert.equal(detail.action, "detail");
  if (detail.action !== "detail") return;
  assert.deepEqual(detail.item.preview, preview);
  const cache = join(cacheDirectory, "catalog-v2.json");
  const stored = JSON.parse(await readFile(cache, "utf8"));
  await writeFile(cache, JSON.stringify({ ...stored, fetchedAt: 0 }));
  offline = true;
  assert.deepEqual(await handleCatalogRequest({ action: "list" }), { ...result, cached: true });
  await assert.rejects(handleCatalogRequest({ action: "detail", type: "block", name: "../outside" }));
});

test("installs isolated editable blocks/examples, renders assets, and leaves components for the agent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "diffusion-catalog-install-"));
  const previous = { ...process.env };
  t.after(async () => { process.env = previous; await rm(root, { recursive: true, force: true }); });
  process.env.XDG_DATA_HOME = join(root, "data");
  const project = join(root, "project");
  await mkdir(project);
  const timeline = "export default () => <video sourceIn={2} sourceOut={5} />;";
  const pkg = { name: "my-project", diffusion: { scenes: { main: { fps: 30 } } } };
  await writeFile(join(project, "package.json"), JSON.stringify(pkg));
  await writeFile(join(project, "index.tsx"), timeline);
  const fake = join(root, "hyperframes");
  await writeFile(join(root, "ffprobe"), `#!${process.execPath}\nconsole.log(JSON.stringify({streams:[{width:1920,height:1080,avg_frame_rate:"30/1"}]}));\n`, { mode: 0o755 });
  process.env.PATH = `${root}:${process.env.PATH}`;
  process.env.DIFFUSION_HYPERFRAMES_BIN = fake;
  process.env.DIFFUSION_CATALOG_TEST_CALLS = join(root, "calls.jsonl");
  await writeFile(fake, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DIFFUSION_CATALOG_TEST_CALLS, JSON.stringify({args, skills:process.env.HYPERFRAMES_SKIP_SKILLS, telemetry:process.env.HYPERFRAMES_NO_TELEMETRY})+'\\n');
if (args[0] === 'render') { fs.writeFileSync(args[args.indexOf('--output') + 1], 'video'); process.exit(0); }
const dest = args[0] === 'init' ? args[1] : args[args.indexOf('--dir') + 1];
fs.mkdirSync(path.join(dest,'compositions'),{recursive:true});
fs.writeFileSync(path.join(dest,args[0] === 'init' ? 'index.html' : 'compositions/scene.html'), '<div data-composition-id="different-root" data-duration="1" data-fps="60"></div>');
if (process.env.DIFFUSION_CATALOG_TEST_FAIL) process.exit(8);
if (args[0] === 'add') console.log(JSON.stringify({ok:true,snippet:'Include the effect'}));
`, { mode: 0o755 });
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(url.includes("test-effect") ? component : url.includes("test-example") ? example : block));

  const first = await handleCatalogRequest({ action: "install", dir: project, name: block.name, type: "block" });
  assert.equal(first.action, "install");
  if (first.action !== "install") return;
  assert.match(await readFile(join(project, first.source, "index.html"), "utf8"), /data-composition-id="different-root" data-composition-src="compositions\/scene.html"/);
  assert.match(await readFile(join(project, first.source, "index.html"), "utf8"), /data-composition-id="catalog-root"[^>]*data-fps="60"/);
  const video = await handleCatalogRequest({ action: "render", dir: project, id: first.id });
  assert.equal(video.action, "render");
  if (video.action !== "render") return;
  assert.ok(video.libraryPath);
  assert.equal(await readFile(join(project, video.output), "utf8"), "video");
  assert.equal(join(project, "assets", video.libraryPath), join(project, video.output));
  const second = await handleCatalogRequest({ action: "install", dir: project, name: block.name, type: "block" });
  assert.equal(second.action, "install");
  if (second.action !== "install") return;
  assert.notEqual(first.source, second.source);
  assert.equal(await readFile(join(project, video.output), "utf8"), "video");

  const effect = await handleCatalogRequest({ action: "install", dir: project, name: component.name, type: "component" });
  assert.equal(effect.action, "install");
  if (effect.action !== "install") return;
  assert.equal(effect.output, undefined);
  assert.equal(effect.snippet, "Include the effect");
  const full = await handleCatalogRequest({ action: "install", dir: project, name: example.name, type: "example" });
  assert.equal(full.action, "install");
  const after = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  assert.deepEqual(after.diffusion.scenes, pkg.diffusion.scenes);
  assert.equal(after.diffusion.animations[effect.id], undefined);
  assert.equal(Object.keys(after.diffusion.animations).length, 3);
  assert.equal(await readFile(join(project, "index.tsx"), "utf8"), timeline);
  const calls = (await readFile(process.env.DIFFUSION_CATALOG_TEST_CALLS, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(calls.filter((call) => call.args[0] !== "render").every((call) => call.skills === "1" && call.telemetry === "1"));
  assert.ok(calls.find((call) => call.args[0] === "add").args.includes("--no-clipboard"));

  process.env.DIFFUSION_CATALOG_TEST_FAIL = "1";
  await assert.rejects(handleCatalogRequest({ action: "install", dir: project, name: block.name, type: "block" }), /exited 8.*Source kept/s);
  assert.deepEqual(JSON.parse(await readFile(join(project, "package.json"), "utf8")), after);
});

test("refuses project symlinks before running installation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "diffusion-catalog-boundary-"));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(root, "cache");
  t.after(async () => { if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous; await rm(root, { recursive: true, force: true }); });
  const project = join(root, "project");
  const outside = join(root, "outside");
  await mkdir(project); await mkdir(outside);
  await writeFile(join(project, "package.json"), "{}");
  await symlink(outside, join(project, "animations"));
  t.mock.method(globalThis, "fetch", async () => Response.json(block));
  await assert.rejects(handleCatalogRequest({ action: "install", dir: project, name: block.name, type: "block" }), /symbolic links/);
  assert.deepEqual(await readdir(outside), []);
});

test("Hyfrme browsing uses its published registry and a separate offline cache", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "diffusion-hyfrme-list-"));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = root;
  t.after(async () => { if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous; await rm(root, { recursive: true, force: true }); });
  let offline = false;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (offline) throw new Error("offline");
    if (url.endsWith("catalog-data.json")) return Response.json([{ item: block }, { item: { ...block, name: "unpublished" } }]);
    if (url.endsWith("registry/registry.json")) return Response.json({ items: [{ name: block.name, type: block.type }] });
    return Response.json(block);
  });
  const result = await handleCatalogRequest({ action: "list" }, "hyfrme");
  assert.equal(result.action, "list");
  if (result.action !== "list") return;
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].poster, "https://hyfrme.vercel.app/previews/test-block/thumbnail.png");
  const detail = await handleCatalogRequest({ action: "detail", name: block.name, type: "block" }, "hyfrme");
  assert.equal(detail.action, "detail");
  if (detail.action !== "detail") return;
  assert.equal(detail.item.preview?.video, "https://hyfrme.vercel.app/previews/test-block/hyperframes.mp4");
  await assert.rejects(handleCatalogRequest({ action: "detail", name: block.name, type: "component" }, "hyfrme"), /Hyfrme catalog items are blocks/);
  const cache = join(root, "diffusion-studio/catalog/hyfrme-catalog.json");
  const stored = JSON.parse(await readFile(cache, "utf8"));
  await writeFile(cache, JSON.stringify({ ...stored, fetchedAt: 0 }));
  offline = true;
  assert.deepEqual(await handleCatalogRequest({ action: "list" }, "hyfrme"), { ...result, cached: true });
  await assert.rejects(handleCatalogRequest({ action: "list" }), /offline/);
});

test("refresh bypasses recent catalog caches and retains the last download offline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "diffusion-catalog-refresh-"));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = root;
  t.after(async () => { if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous; await rm(root, { recursive: true, force: true }); });
  const directory = join(root, "diffusion-studio/catalog");
  await mkdir(directory, { recursive: true });
  for (const key of ["catalog-v2", "hyfrme-catalog"]) {
    await writeFile(join(directory, `${key}.json`), JSON.stringify({ fetchedAt: Date.now(), value: [] }));
  }
  let offline = false;
  let downloads = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    downloads++;
    if (offline) throw new Error("offline");
    if (url.endsWith("catalog-data.json")) return Response.json([{ item: block }]);
    if (url.endsWith("catalog-index.json")) return Response.json([{ ...block, type: "block" }]);
    if (url.endsWith("registry/registry.json")) return Response.json({ items: [{ name: block.name, type: block.type }] });
    throw new Error(`Unexpected download: ${url}`);
  });
  for (const source of ["hyperframes", "hyfrme"] as const) {
    const before = await handleCatalogRequest({ action: "list" }, source);
    assert.equal(before.action, "list");
    if (before.action !== "list") return;
    assert.ok(!before.items.some((item) => item.name === block.name));
  }
  assert.equal(downloads, 0);
  for (const source of ["hyperframes", "hyfrme"] as const) {
    const refreshed = await handleCatalogRequest({ action: "list", refresh: true }, source);
    assert.equal(refreshed.action, "list");
    if (refreshed.action !== "list") return;
    assert.equal(refreshed.cached, false);
    assert.ok(refreshed.items.some((item) => item.name === block.name));
    assert.deepEqual(await handleCatalogRequest({ action: "list" }, source), { ...refreshed, cached: true });
    offline = true;
    assert.deepEqual(await handleCatalogRequest({ action: "list", refresh: true }, source), { ...refreshed, cached: true });
    offline = false;
  }
});

test("Hyfrme installs through its CLI and registers editable source with preserved licenses", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "diffusion-hyfrme-install-"));
  const previous = { ...process.env };
  t.after(async () => { process.env = previous; await rm(root, { recursive: true, force: true }); });
  process.env.XDG_DATA_HOME = join(root, "data");
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "project", diffusion: { scenes: { main: { fps: 30 } } } }));
  const fake = join(root, "hyfrme");
  process.env.DIFFUSION_HYFRME_BIN = fake;
  process.env.HYFRME_REGISTRY_URL = "https://unrelated.invalid/registry";
  await writeFile(fake, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const dest = args[args.indexOf('--dir') + 1];
if (args[0] !== 'add' || args[1] !== 'test-block') process.exit(2);
if (process.env.HYFRME_REGISTRY_URL !== 'https://hyfrme.vercel.app/registry') process.exit(3);
if (JSON.parse(fs.readFileSync(path.join(dest,'hyperframes.json'),'utf8')).registry !== process.env.HYFRME_REGISTRY_URL) process.exit(4);
fs.mkdirSync(path.join(dest,'compositions')); fs.mkdirSync(path.join(dest,'THIRD_PARTY_LICENSES'));
fs.writeFileSync(path.join(dest,'compositions/scene.html'), '<template><div data-fps="30000/1001" data-composition-id="hyfrme-root"><div data-fps="24"></div></div></template>');
fs.writeFileSync(path.join(dest,'THIRD_PARTY_LICENSES/font.txt'), 'font license');
console.log('Use the Hyfrme block');
`, { mode: 0o755 });
  t.mock.method(globalThis, "fetch", async () => Response.json(block));
  const result = await handleCatalogRequest({ action: "install", dir: project, name: block.name, type: "block" }, "hyfrme");
  assert.equal(result.action, "install");
  if (result.action !== "install") return;
  assert.match(await readFile(join(project, result.source, "index.html"), "utf8"), /data-composition-id="hyfrme-root" data-composition-src="compositions\/scene.html"/);
  assert.match(await readFile(join(project, result.source, "index.html"), "utf8"), /data-composition-id="catalog-root"[^>]*data-fps="30000\/1001"/);
  assert.equal(await readFile(join(project, result.source, "THIRD_PARTY_LICENSES/font.txt"), "utf8"), "font license");
  const pkg = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  assert.deepEqual(pkg.diffusion.scenes, { main: { fps: 30 } });
  assert.deepEqual(pkg.diffusion.animations[result.id], { engine: "hyperframes", source: result.source, output: result.output });
});

test("overlapping catalog installs retain both registrations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "diffusion-catalog-concurrent-"));
  const previous = { ...process.env };
  t.after(async () => { process.env = previous; await rm(root, { recursive: true, force: true }); });
  process.env.XDG_DATA_HOME = join(root, "data");
  const project = join(root, "project");
  await mkdir(project);
  const packagePath = join(project, "package.json");
  const pkg = { name: "project", diffusion: { scenes: { main: { fps: 30 } } } };
  await writeFile(packagePath, JSON.stringify(pkg));
  const fake = join(root, "hyperframes");
  process.env.DIFFUSION_HYPERFRAMES_BIN = fake;
  await writeFile(fake, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const dest = process.argv[process.argv.indexOf('--dir') + 1];
fs.mkdirSync(path.join(dest, 'compositions'));
fs.writeFileSync(path.join(dest, 'compositions/scene.html'), '<div data-composition-id="test-block"></div>');
console.log(JSON.stringify({ok:true,snippet:''}));
`, { mode: 0o755 });
  t.mock.method(globalThis, "fetch", async () => Response.json(block));
  const fs = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const rename = fs.rename;
  const reachedPublish = Promise.withResolvers<void>();
  const releasePublish = Promise.withResolvers<void>();
  let held = false;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
    if (args[1] === packagePath && !held) {
      held = true;
      reachedPublish.resolve();
      await releasePublish.promise;
    }
    return rename(...args);
  });
  const request = { action: "install", dir: project, name: block.name, type: "block" };
  const first = handleCatalogRequest(request);
  await reachedPublish.promise;
  const second = handleCatalogRequest(request);
  const installed = Promise.all([first, second]);
  try {
    // Hold the first atomic replace while the other local install reaches registration.
    await Promise.race([second, new Promise(resolve => setTimeout(resolve, 300))]);
  } finally { releasePublish.resolve(); }
  const results = await installed;
  const after = JSON.parse(await readFile(packagePath, "utf8"));
  assert.deepEqual(after.diffusion.scenes, pkg.diffusion.scenes);
  assert.equal(Object.keys(after.diffusion.animations).length, 2);
  for (const result of results) {
    assert.equal(result.action, "install");
    if (result.action !== "install") continue;
    assert.equal(after.diffusion.animations[result.id].source, result.source);
    await readFile(join(project, result.source, "index.html"));
  }
  assert.ok((await readdir(project)).every(name => !name.startsWith(".package-")));
});

test("catalog details retain editable variables and metadata instead of reusing stripped manifests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "diffusion-catalog-manifest-"));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = root;
  t.after(async () => { if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous; await rm(root, { recursive: true, force: true }); });
  const cache = join(root, "diffusion-studio/catalog");
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "component-test-effect.json"), JSON.stringify({ fetchedAt: Date.now(), value: { ...component, type: "component" } }));
  const variables = [{ id: "accent", type: "enum", default: "green", options: [{ value: "green", label: "Green" }] }];
  const metadata = { variables, registryDependencies: ["test-block"], syncPoints: [{ id: "landed", offset: 1.5 }], license: "MIT" };
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...component, ...metadata }));
  const result = await handleCatalogRequest({ action: "detail", name: component.name, type: "component" });
  assert.equal(result.action, "detail");
  if (result.action !== "detail") return;
  assert.deepEqual(result.item.variables, variables);
  assert.deepEqual(result.item.registryDependencies, metadata.registryDependencies);
  assert.deepEqual(result.item.syncPoints, metadata.syncPoints);
  assert.equal(result.item.license, "MIT");
  assert.deepEqual(result.item.files, component.files);
});

test("catalog previews use published composition payloads and remain available offline without installing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "diffusion-catalog-preview-"));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = root;
  t.after(async () => { if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous; await rm(root, { recursive: true, force: true }); });
  const html = '<div data-composition-id="test-effect" data-duration="3">Published preview</div>';
  let offline = false;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, "https://raw.githubusercontent.com/heygen-com/hyperframes/main/docs/public/catalog/components/test-effect.json");
    if (offline) throw new Error("offline");
    return Response.json({ html });
  });
  const request = { action: "preview", name: component.name, type: "component" };
  assert.deepEqual(await handleCatalogRequest(request), { action: "preview", html });
  const cache = join(root, "diffusion-studio/catalog/preview-component-test-effect.json");
  const stored = JSON.parse(await readFile(cache, "utf8"));
  await writeFile(cache, JSON.stringify({ ...stored, fetchedAt: 0 }));
  offline = true;
  assert.deepEqual(await handleCatalogRequest(request), { action: "preview", html });
  await assert.rejects(handleCatalogRequest({ ...request, name: "../outside" }));
  await assert.rejects(handleCatalogRequest({ ...request, type: "example" }));
  await assert.rejects(handleCatalogRequest(request, "hyfrme"), /published video/);
  assert.deepEqual(await readdir(root), ["diffusion-studio"]);
});

test("website templates attach pinned remix metadata and install editable packages with provenance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "diffusion-website-template-"));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(root, "cache");
  t.after(async () => { if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous; await rm(root, { recursive: true, force: true }); });
  const project = join(root, "project");
  await mkdir(project);
  const pkg = { diffusion: { scenes: { main: { fps: 30 } } } };
  await writeFile(join(project, "package.json"), JSON.stringify(pkg));
  await writeFile(join(project, "index.tsx"), "Keep the timeline");
  const archive = await readFile(new URL("./fixtures/hyperframes-template.zip", import.meta.url));
  const name = "notification-cascade";
  const revision = "254fe4bd8a3f00c1e70ac5e38a1bce25060f7590";
  const variables = [{ id: "appName", type: "string", default: "HyperFrames" }];
  let unsafe = false;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("template.zip")) {
      assert.equal(url, `https://static.heygen.ai/hyperframes/templates/promoted/${revision}/${name}/template.zip`);
      return new Response(unsafe ? Buffer.from(archive.toString("latin1").replaceAll("index.html", "../outside"), "latin1") : archive);
    }
    assert.ok(url.includes(revision));
    if (url.endsWith("TEMPLATE.md")) return new Response("Keep the layout. Edit declared content variables.");
    if (url.endsWith("LICENSE")) return new Response("Apache License, Version 2.0");
    return Response.json({ ...block, name, variables });
  });
  const detail = await handleCatalogRequest({ action: "detail", type: "template", name });
  assert.equal(detail.action, "detail");
  if (detail.action !== "detail" || detail.item.type !== "template") return;
  assert.equal(detail.item.templateSource.revision, revision);
  assert.equal(detail.item.templateSource.website, "https://www.hyperframes.dev/");
  assert.match(detail.item.templateSource.instructions, /declared content variables/);
  assert.deepEqual(detail.item.variables, variables);
  assert.match(detail.item.preview!.video!, /promoted\/.*\/preview.mp4$/);
  const installed = await handleCatalogRequest({ action: "install", dir: project, type: "template", name });
  assert.equal(installed.action, "install");
  if (installed.action !== "install") return;
  const source = join(project, installed.source);
  assert.match(await readFile(join(source, "index.html"), "utf8"), /Editable source/);
  assert.equal(await readFile(join(source, "assets/logo.svg"), "utf8"), "<svg/>");
  assert.match(await readFile(join(source, "LICENSE.hyperframes"), "utf8"), /Apache/);
  const provenance = JSON.parse(await readFile(join(source, "diffusion-template-source.json"), "utf8"));
  assert.equal(provenance.revision, revision);
  assert.match(provenance.packageSha256, /^[0-9a-f]{64}$/);
  const after = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  assert.deepEqual(after.diffusion.scenes, pkg.diffusion.scenes);
  assert.equal(after.diffusion.animations[installed.id].source, installed.source);
  assert.equal(after.diffusion.animations[installed.id].entry, "index.html");
  assert.equal(await readFile(join(project, "index.tsx"), "utf8"), "Keep the timeline");
  assert.ok(!(await readdir(source)).includes(".template-package.zip"));
  unsafe = true;
  await assert.rejects(handleCatalogRequest({ action: "install", dir: project, type: "template", name }), /invalid relative path|unsafe path/);
  assert.deepEqual(JSON.parse(await readFile(join(project, "package.json"), "utf8")), after);
  assert.ok(!(await readdir(join(project, "animations"))).includes("outside"));
  await assert.rejects(handleCatalogRequest({ action: "detail", type: "template", name: "unknown-template" }), /Unknown HyperFrames website template/);
});
