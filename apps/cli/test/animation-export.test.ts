import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { cancelAnimation, exportAnimation, listAnimations, renderAnimation } from "../src/animation.ts";

function command(executable: string, args: string[], input?: Buffer) {
  const result = spawnSync(executable, args, { input });
  assert.equal(result.status, 0, result.stderr?.toString() ?? result.error?.message);
  return result.stdout;
}

async function projectFixture(t: TestContext, config: Record<string, unknown>) {
  const project = await mkdtemp(join(tmpdir(), "diffusion-animation-export-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(join(project, "source"));
  await mkdir(join(project, "assets"));
  await writeFile(join(project, "source", "index.html"), '<main data-fps="60"></main>');
  await writeFile(join(project, "package.json"), JSON.stringify({ diffusion: { animations: { clip: { engine: "hyperframes", source: "source", ...config } } } }));
  return project;
}

const pixels = Buffer.from([64, 16, 8, 128, 0, 255, 0, 255, 0, 0, 0, 0, 255, 0, 0, 64, 64, 16, 8, 128, 0, 255, 0, 255, 0, 0, 0, 0, 255, 0, 0, 64]);
function transparentPng() {
  return command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "4x2", "-i", "pipe:0", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"], pixels);
}

function probe(path: string) {
  return JSON.parse(command("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,profile,pix_fmt,avg_frame_rate,nb_frames,duration", "-of", "json", path]).toString()).streams[0];
}

test("exports opaque bytes unchanged, refuses source aliases and preserves existing exports", async (t) => {
  const project = await projectFixture(t, { output: "assets/clip.mp4" });
  const original = join(project, "assets", "clip.mp4");
  await assert.rejects(exportAnimation("clip", project, "exports/clip.mp4"), /Render this animation/);
  command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=red:s=16x16:r=30:d=0.1", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", original]);
  const originalBytes = await readFile(original);
  const exported = await exportAnimation("clip", project, "exports/clip.mp4");
  assert.deepEqual(exported, { id: "clip", output: join(project, "exports", "clip.mp4"), format: "mp4", transparent: false });
  assert.deepEqual(await readFile(exported.output), originalBytes);
  await writeFile(exported.output, "previous export");
  await assert.rejects(exportAnimation("clip", project, exported.output), /already exists/);
  assert.equal(await readFile(exported.output, "utf8"), "previous export");
  await exportAnimation("clip", project, exported.output, { overwrite: true });
  assert.deepEqual(await readFile(exported.output), originalBytes);
  await writeFile(original, "corrupted video");
  await assert.rejects(exportAnimation("clip", project, exported.output, { overwrite: true }), /Animation renderer exited/);
  assert.deepEqual(await readFile(exported.output), originalBytes);
  await writeFile(original, originalBytes);
  await assert.rejects(exportAnimation("clip", project, original, { overwrite: true }), /registered animation output/);
  await assert.rejects(exportAnimation("clip", project, "source/clip.mp4", { overwrite: true }), /source files/);
  await assert.rejects(exportAnimation("clip", project, "exports/clip.mov"), /MP4/);
  const hardlink = join(project, "source-alias.mp4");
  await link(original, hardlink);
  await assert.rejects(exportAnimation("clip", project, hardlink, { overwrite: true }), /animation source/);
  await symlink(join(project, "exports"), join(project, "export-alias"));
  await assert.rejects(exportAnimation("clip", project, "export-alias/clip.mp4", { overwrite: true }), /symbolic links/);
  assert.deepEqual(await readFile(original), originalBytes);
  assert.deepEqual(await readdir(join(project, "exports")), ["clip.mp4"]);
});

test("exports straight-alpha ProRes 4444 with sequence FPS and frame count", async (t) => {
  const project = await projectFixture(t, { transparent: true, frameRate: 30, output: "assets/60% sequence.frames" });
  const frames = join(project, "assets", "60% sequence.frames");
  await mkdir(frames);
  const png = transparentPng();
  for (let index = 0; index < 6; index++) await writeFile(join(frames, `${String(index).padStart(6, "0")}.png`), png);
  await writeFile(join(frames, ".sequence.json"), JSON.stringify({ frameRate: 60 }));
  const [listed] = await listAnimations(project);
  assert.ok("engine" in listed);
  assert.equal(listed.frameRate, 60);
  const result = await exportAnimation("clip", project, "exports/overlay.mov");
  const info = probe(result.output);
  assert.equal(info.codec_name, "prores");
  assert.equal(info.profile, "4444");
  assert.match(info.pix_fmt, /^yuva444/);
  assert.equal(info.avg_frame_rate, "60/1");
  assert.equal(info.nb_frames, "6");
  assert.ok(Math.abs(Number(info.duration) - 0.1) < 0.0001);
  const decoded = command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", result.output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
  assert.equal(decoded.length, pixels.length);
  for (const index of [0, 1, 2, 3, 7, 11, 15]) assert.ok(Math.abs(decoded[index] - pixels[index]) <= 2, `Channel ${index} changed from ${pixels[index]} to ${decoded[index]}`);
  assert.deepEqual(await readFile(join(frames, "000000.png")), png);

  await rm(join(frames, ".sequence.json"));
  const legacy = await exportAnimation("clip", project, "exports/legacy.mov");
  assert.equal(probe(legacy.output).avg_frame_rate, "30/1");
  await writeFile(join(frames, "000002.png"), "corrupt frame");
  await assert.rejects(exportAnimation("clip", project, result.output, { overwrite: true }), /invalid PNG/);
  assert.equal(probe(result.output).nb_frames, "6");
});

test("renders HyperFrames alpha without unpremultiplying and stores actual frame rate", async (t) => {
  const project = await projectFixture(t, { transparent: true, output: "assets/clip.frames" });
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  const png = join(project, "source", "input.png");
  await writeFile(png, transparentPng());
  const movie = join(project, "fixture.mov");
  command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", "60", "-i", png, "-frames:v", "3", "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", movie]);
  const renderer = join(project, "renderer");
  const callPath = join(project, "call.json");
  await writeFile(renderer, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync('${callPath}', JSON.stringify(args));
fs.copyFileSync('${movie}', args[args.indexOf('--output')+1]);
`, { mode: 0o755 });
  process.env.DIFFUSION_HYPERFRAMES_BIN = renderer;
  const result = await renderAnimation("clip", project, "hyperframes");
  const args = JSON.parse(await readFile(callPath, "utf8"));
  assert.equal(args[args.indexOf("--format") + 1], "mov");
  assert.ok(!args.includes("--fps"));
  assert.equal(result.frameRate, 60);
  assert.deepEqual(JSON.parse(await readFile(join(result.output, ".sequence.json"), "utf8")), { frameRate: 60 });
  const decoded = command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", join(result.output, "frame000001.png"), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
  for (const index of [0, 1, 2, 3]) assert.ok(Math.abs(decoded[index] - pixels[index]) <= 2, `HyperFrames channel ${index} was incorrectly unpremultiplied`);

  const pkg = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  pkg.diffusion.animations.clip.frameRate = 24;
  await writeFile(join(project, "package.json"), JSON.stringify(pkg));
  await renderAnimation("clip", project);
  const explicit = JSON.parse(await readFile(callPath, "utf8"));
  assert.equal(explicit[explicit.indexOf("--fps") + 1], "24");
});

test("rejects a renderer's non-video output without replacing the previous preview", async (t) => {
  const project = await projectFixture(t, { output: "assets/clip.mp4" });
  const previous = process.env.DIFFUSION_HYPERFRAMES_BIN;
  t.after(() => { if (previous === undefined) delete process.env.DIFFUSION_HYPERFRAMES_BIN; else process.env.DIFFUSION_HYPERFRAMES_BIN = previous; });
  const output = join(project, "assets", "clip.mp4");
  await writeFile(output, "previous preview");
  const renderer = join(project, "renderer");
  await writeFile(renderer, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.argv[process.argv.indexOf('--output')+1], '<html>not a video</html>');
`, { mode: 0o755 });
  process.env.DIFFUSION_HYPERFRAMES_BIN = renderer;
  await assert.rejects(renderAnimation("clip", project), /Animation renderer exited/);
  assert.equal(await readFile(output, "utf8"), "previous preview");
  assert.deepEqual(await readdir(join(project, "assets")), ["clip.mp4"]);
});

test("cancels exports before publishing and leaves the previous file intact", async (t) => {
  const project = await projectFixture(t, { transparent: true, output: "assets/clip.frames" });
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  const frames = join(project, "assets", "clip.frames");
  await mkdir(frames);
  const png = transparentPng();
  await writeFile(join(frames, "frame1.png"), png);
  await writeFile(join(frames, "frame2.png"), png);
  const output = join(project, "previous.mov");
  await writeFile(output, "previous export");
  const controller = new AbortController();
  controller.abort(new Error("Caller stopped export"));
  await assert.rejects(exportAnimation("clip", project, output, { overwrite: true, signal: controller.signal }), /Caller stopped export/);
  const started = join(project, "started");
  await writeFile(join(project, "ffmpeg"), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync('${started}', 'started');
setTimeout(() => fs.writeFileSync(process.argv.at(-1), 'new export'), 5000);
`, { mode: 0o755 });
  process.env.PATH = `${project}:${process.env.PATH}`;
  const exporting = exportAnimation("clip", project, output, { overwrite: true });
  const cancelled = assert.rejects(exporting, /cancelled/);
  for (let attempt = 0; attempt < 100 && !await access(started).then(() => true, () => false); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  await access(started);
  assert.equal(await cancelAnimation("clip", project), true);
  await cancelled;
  assert.equal(await readFile(output, "utf8"), "previous export");
  assert.ok((await readdir(project)).every(name => !name.startsWith(".animation-")));
});

test("an export cannot replace an animation registered while it was running", async (t) => {
  const project = await projectFixture(t, { output: "assets/clip.mp4" });
  const previous = process.env.PATH;
  t.after(() => { process.env.PATH = previous; });
  await writeFile(join(project, "assets", "clip.mp4"), "existing rendered video");
  await writeFile(join(project, "ffprobe"), `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const file = path.join(process.cwd(), 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.diffusion.animations.newPreview = {engine:'hyperframes',source:'source',output:'exports/clip.mp4'};
fs.writeFileSync(file, JSON.stringify(pkg));
fs.writeFileSync(path.join(process.cwd(), 'exports/clip.mp4'), 'new registered preview');
console.log(JSON.stringify({streams:[{width:2,height:2,avg_frame_rate:'30/1'}]}));
`, { mode: 0o755 });
  process.env.PATH = `${project}:${process.env.PATH}`;
  await assert.rejects(exportAnimation("clip", project, "exports/clip.mp4", { overwrite: true }), /registered animation output/);
  assert.equal(await readFile(join(project, "exports", "clip.mp4"), "utf8"), "new registered preview");
  assert.deepEqual(await readdir(join(project, "exports")), ["clip.mp4"]);
});

test("a render cannot publish after its registration changes", async (t) => {
  const project = await projectFixture(t, { output: "assets/clip.mp4" });
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  await writeFile(join(project, "assets", "clip.mp4"), "previous preview");
  await writeFile(join(project, "renderer"), `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
fs.writeFileSync(process.argv[process.argv.indexOf('--output') + 1], 'new render');
const file = path.join(process.cwd(), '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.diffusion.animations.clip.output = 'assets/revised.mp4';
fs.writeFileSync(file, JSON.stringify(pkg));
`, { mode: 0o755 });
  await writeFile(join(project, "ffprobe"), `#!${process.execPath}\nconsole.log(JSON.stringify({streams:[{width:2,height:2,avg_frame_rate:'30/1'}]}));\n`, { mode: 0o755 });
  process.env.DIFFUSION_HYPERFRAMES_BIN = join(project, "renderer");
  process.env.PATH = `${project}:${process.env.PATH}`;
  await assert.rejects(renderAnimation("clip", project), /registration changed/);
  assert.equal(await readFile(join(project, "assets", "clip.mp4"), "utf8"), "previous preview");
  assert.deepEqual(await readdir(join(project, "assets")), ["clip.mp4"]);
});
