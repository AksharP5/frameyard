import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { runInThisContext } from "node:vm";
import { buildSync } from "esbuild";

const filename = fileURLToPath(new URL("../../desktop/src/projects.ts", import.meta.url));
const require = createRequire(filename);
const code = buildSync({
  entryPoints: [filename], bundle: true, platform: "node", format: "cjs", write: false,
  external: ["electron", "esbuild", "@babel/core", "@babel/preset-typescript", "babel-preset-solid", "ts-morph"],
}).outputFiles[0].text;

/** Exercises the desktop's filesystem boundary without starting Electron. */
function projectsFor(dir: string) {
  const electron = {
    app: {
      getPath: (name: string) => join(dir, name),
      isPackaged: false,
    },
    ipcMain: { on() {} },
  };
  const module = { exports: {} as Pick<typeof import("../../desktop/src/projects.ts"), "initProject" | "compileProject" | "readManifest" | "writeManifest" | "watchProject" | "unwatchProject" | "markSelfWrite"> };
  runInThisContext(`(function(require,module,exports,__filename,__dirname,process){${code}\n})`)(
    (name: string) => {
      if (name === "electron") return electron;
      // The compile still uses real Babel/esbuild, resolved from this checkout.
      if (name === "node:module") return { ...require(name), createRequire: () => require };
      return require(name);
    },
    module, module.exports, filename, dirname(filename), process,
  );
  return module.exports;
}

test("first open gives a folder with spaces a stable id without changing source or custom settings", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "diffusion open "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const projectDir = join(dir, "Local workflow");
  await mkdir(projectDir);
  const source = 'export default () => <scene id="proof"/>;\n';
  const settings = { main: "index.tsx", diffusion: { custom: "preserve" } };
  await writeFile(join(projectDir, "index.tsx"), source);
  await writeFile(join(projectDir, "package.json"), JSON.stringify(settings));

  const projects = projectsFor(dir);
  const first = await projects.initProject(null, projectDir);
  assert.match(first.id, /^[A-Za-z0-9_-]+$/);
  assert.equal(first.dir, projectDir);
  const saved = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
  assert.equal(saved.main, settings.main);
  assert.deepEqual(saved.diffusion, settings.diffusion);
  assert.equal(saved.projectId, first.id);
  assert.equal(saved.displayName, "Local workflow");
  assert.equal(saved.scripts.open, "dapi open .");
  assert.equal(await readFile(join(projectDir, "index.tsx"), "utf8"), source);
  const reopened = await projects.initProject(null, projectDir);
  assert.equal(reopened.id, first.id);
});

test("concurrent manifest saves remain complete and initialization preserves existing assets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "diffusion-manifest-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const projects = projectsFor(dir);
  const manifests = Array.from({ length: 12 }, (_, index) => ({
    version: 1, folders: [`folder-${index}`], assets: [],
  }));
  await Promise.all(manifests.map(manifest => projects.writeManifest(dir, manifest)));
  const saved = await projects.readManifest(dir);
  assert.ok(manifests.some(manifest => JSON.stringify(manifest) === JSON.stringify(saved)));
  await Promise.all(Array.from({ length: 6 }, () => projects.writeManifest(dir, {
    version: 1, folders: [], assets: [],
  }, { createOnly: true })));
  assert.deepEqual(await projects.readManifest(dir), saved);
  assert.deepEqual(await readdir(dir), ["assets.yml"]);

  // A failed publication must leave no staged file or replace the destination.
  await rm(join(dir, "assets.yml"));
  await mkdir(join(dir, "assets.yml"));
  await assert.rejects(projects.writeManifest(dir, manifests[0]));
  assert.deepEqual(await readdir(dir), ["assets.yml"]);
  assert.ok((await stat(join(dir, "assets.yml"))).isDirectory());
});

test("directory watches retain nested source edits after atomic saves and folder moves", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "diffusion-source-watch-"));
  const projects = projectsFor(dir);
  const source = "components/scene.tsx";
  await mkdir(join(dir, "components"));
  await writeFile(join(dir, source), "original");
  const events: string[] = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      isLoadingMainFrame: () => false,
      send: (_wire: string, event: { data: { dir: string; path: string } }) => {
        assert.equal(event.data.dir, dir);
        events.push(event.data.path);
      },
    },
  };
  projects.watchProject(window as unknown as Parameters<typeof projects.watchProject>[0], dir);
  t.after(async () => {
    projects.unwatchProject(dir);
    await rm(dir, { recursive: true, force: true });
  });
  const expectChange = async (path: string, write: () => Promise<unknown>) => {
    events.length = 0;
    await write();
    for (let attempt = 0; attempt < 100 && !events.includes(path); attempt++) await setTimeout(20);
    assert.ok(events.includes(path), `watching must still report ${path}`);
  };
  const atomicSave = async (text: string) => {
    const temporary = join(dir, `${source}.diffusion-save-${randomUUID()}`);
    await writeFile(temporary, text);
    await rename(temporary, join(dir, source));
  };

  projects.markSelfWrite(dir, source, "GUI save");
  await atomicSave("GUI save");
  await setTimeout(1100);
  assert.deepEqual(events, [], "GUI saves and staging files remain quiet");
  await expectChange(source, () => writeFile(join(dir, source), "external in-place edit"));
  await expectChange(source, () => atomicSave("external atomic edit"));
  await expectChange(source, () => writeFile(join(dir, source), "another in-place edit"));

  await expectChange("new", async () => {
    await mkdir(join(dir, "new/nested"), { recursive: true });
    await writeFile(join(dir, "new/nested/title.tsx"), "new component");
  });
  await expectChange("new/nested/title.tsx", () => writeFile(join(dir, "new/nested/title.tsx"), "edited component"));
  await expectChange("moved", () => rename(join(dir, "new"), join(dir, "moved")));
  await expectChange("moved/nested/title.tsx", () => writeFile(join(dir, "moved/nested/title.tsx"), "edited after moving"));

  events.length = 0;
  for (const ignored of [".diffusion", "node_modules"]) {
    await mkdir(join(dir, ignored));
    await writeFile(join(dir, ignored, "internal.tsx"), "ignored");
  }
  await setTimeout(100);
  assert.deepEqual(events, []);
});
