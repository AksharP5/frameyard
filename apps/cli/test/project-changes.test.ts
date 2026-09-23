import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { ProjectChanges } from "../../desktop/src/project-changes.ts";
import { batchProjectChanges, isProjectSourceFile } from "../../web/src/projects/change-batch.ts";

test("editor writes stay quiet while immediate agent edits are delivered", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "diffusion-changes-"));
  const events: string[] = [];
  const changes = new ProjectChanges(dir, (path) => events.push(path), 20);
  t.after(async () => {
    changes.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const file = join(dir, "index.tsx");
  changes.mark("index.tsx", "GUI moved the title");
  await writeFile(file, "GUI moved the title");
  changes.changed("index.tsx");
  await setTimeout(60);
  assert.deepEqual(events, []);

  changes.mark("index.tsx", "GUI resized the title");
  await writeFile(file, "GUI resized the title");
  changes.changed("index.tsx");
  await writeFile(file, "Agent changed the title immediately afterward");
  changes.changed("index.tsx");
  await setTimeout(60);
  assert.deepEqual(events, ["index.tsx"]);
});

test("binary writes emit once after settling and removals detect recreation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "diffusion-changes-"));
  const events: string[] = [];
  const changes = new ProjectChanges(dir, (path) => events.push(path), 20);
  t.after(async () => {
    changes.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  for (let chunk = 0; chunk < 5; chunk++) {
    changes.mark("assets/title.mp4");
    changes.changed("assets/title.mp4");
  }
  changes.mark(".assets.yml.tmp", null);
  changes.changed(".assets.yml.tmp");
  changes.mark("removed.tsx", null);
  await writeFile(join(dir, "removed.tsx"), "agent restored the file");
  changes.changed("removed.tsx");
  changes.changed("external.tsx");
  assert.deepEqual(events, ["external.tsx"]);
  await setTimeout(60);
  assert.deepEqual(events.sort(), ["assets/title.mp4", "external.tsx", "removed.tsx"]);
  changes.mark("assets/cancelled.mp4");
  changes.dispose();
  await setTimeout(40);
  assert.equal(events.length, 3);
});

test("private context and dependency writes stay quiet while generated assets and source edits notify", async (t) => {
  const events: string[] = [];
  const changes = new ProjectChanges("/unused", (path) => events.push(path), 20);
  t.after(() => changes.dispose());
  for (const path of [".diffusion", ".diffusion/transcription/mix.ogg", ".diffusion/video-context/take/frame-01.png", "node_modules", "node_modules/package/index.js"]) {
    changes.changed(path);
    changes.mark(path);
    changes.changed(path);
  }
  changes.mark("assets/new.PNG");
  changes.changed("assets/new.PNG");
  changes.changed("index.tsx");
  changes.changed(".diffusionary.tsx");
  assert.deepEqual(events, ["index.tsx", ".diffusionary.tsx"]);
  await setTimeout(60);
  assert.deepEqual(events, ["index.tsx", ".diffusionary.tsx", "assets/new.PNG"]);
});

test("native recursive watching delivers atomic external component edits during ongoing render writes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "diffusion-native-watch-"));
  await mkdir(join(dir, "assets"));
  const source = "assets/scene.tsx";
  await writeFile(join(dir, source), "before");
  const loaded: string[] = [];
  const batch = batchProjectChanges((paths) => {
    if (paths.some(isProjectSourceFile)) void readFile(join(dir, source), "utf8").then((text) => loaded.push(text));
  }, 40, 80);
  const changes = new ProjectChanges(dir, (path) => batch.add(path), 20);
  const watcher = watch(dir, { recursive: true }, (_event, path) => { if (path) changes.changed(path); });
  let rendering: ReturnType<typeof setInterval> | undefined;
  t.after(async () => { clearInterval(rendering); watcher.close(); changes.dispose(); batch.dispose(); await rm(dir, {recursive: true, force: true}); });
  changes.mark(source, "GUI save");
  await writeFile(join(dir, source), "GUI save");
  await writeFile(join(dir, "assets/agent.tmp"), "agent edit");
  await rename(join(dir, "assets/agent.tmp"), join(dir, source));
  rendering = setInterval(() => { void writeFile(join(dir, "assets/frame.png"), "frame"); }, 10);
  for (let attempt = 0; attempt < 20 && !loaded.includes("agent edit"); attempt++) await setTimeout(20);
  assert.ok(loaded.includes("agent edit"), "external source edit reaches reload without stopping render activity");
});
