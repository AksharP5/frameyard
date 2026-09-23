import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportAnimation, renderAnimation, shutdownAnimations } from "../src/animation.ts";

test("shutdown stops active render and export processes before removing staging files", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "diffusion-animation-shutdown-"));
  const previous = { ...process.env };
  t.after(async () => {
    await shutdownAnimations();
    process.env = previous;
    await rm(project, { recursive: true, force: true });
  });
  await mkdir(join(project, "source"));
  await mkdir(join(project, "assets"));
  await writeFile(join(project, "source", "index.html"), '<main data-fps="60"></main>');
  await writeFile(join(project, "package.json"), JSON.stringify({ diffusion: { animations: {
    title: { engine: "hyperframes", source: "source", output: "assets/title.mp4" },
    overlay: { engine: "hyperframes", source: "source", transparent: true, output: "assets/overlay.frames" },
  } } }));
  const rendered = join(project, "assets", "title.mp4");
  const exported = join(project, "overlay.mov");
  await writeFile(rendered, "previous preview");
  await writeFile(exported, "previous export");
  const frames = join(project, "assets", "overlay.frames");
  await mkdir(frames);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAE0lEQVR4nGP8z8AARAwMLAxQAAAfKQIESEBLNwAAAABJRU5ErkJggg==", "base64");
  await writeFile(join(frames, "frame1.png"), png);
  await writeFile(join(frames, "frame2.png"), png);
  await writeFile(join(frames, ".sequence.json"), JSON.stringify({ frameRate: 60 }));
  for (const name of ["renderer", "ffmpeg"]) {
    await writeFile(join(project, name), `#!${process.execPath}
const fs = require('node:fs');
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 30));
fs.writeFileSync(__filename + '.pid', String(process.pid));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  }
  process.env.DIFFUSION_HYPERFRAMES_BIN = join(project, "renderer");
  process.env.PATH = `${project}:${process.env.PATH}`;
  const rendering = assert.rejects(renderAnimation("title", project), /shutting down/);
  const exporting = assert.rejects(exportAnimation("overlay", project, exported, { overwrite: true }), /shutting down/);
  const markers = [join(project, "renderer.pid"), join(project, "ffmpeg.pid")];
  for (const marker of markers) {
    for (let attempt = 0; attempt < 100 && !await access(marker).then(() => true, () => false); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    await access(marker);
  }
  const pids = await Promise.all(markers.map(async path => Number(await readFile(path, "utf8"))));
  for (const pid of pids) process.kill(pid, 0);
  await shutdownAnimations();
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.ok((await readdir(project)).every(name => !name.startsWith(".animation-")));
  assert.ok((await readdir(join(project, "assets"))).every(name => !name.startsWith(".animation-")));
  assert.equal(await readFile(rendered, "utf8"), "previous preview");
  assert.equal(await readFile(exported, "utf8"), "previous export");
  assert.deepEqual(await readFile(join(frames, "frame1.png")), png);
  await Promise.all([rendering, exporting]);
  await assert.rejects(renderAnimation("title", project), /shutting down/);
});
