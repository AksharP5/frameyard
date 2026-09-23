import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cancelAnimation, listAnimations, renderAnimation } from "../src/animation.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAE0lEQVR4nGP8z8AARAwMLAxQAAAfKQIESEBLNwAAAABJRU5ErkJggg==", "base64");

test("renders retained Manim and HyperFrames sources and preserves the last good artifact", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "diffusion-animation-"));
  const before = { ...process.env };
  t.after(async () => {
    process.env = before;
    await rm(project, { recursive: true, force: true });
  });
  const source = join(project, "animations", "diagram with spaces");
  await mkdir(source, { recursive: true });
  const entry = "from manim import *\nclass Diagram(Scene):\n    pass\n";
  const html = '<main data-duration="1">Title</main>';
  const timeline = '<video id="diagram" src="assets/diagram.mp4" start={4} sourceIn={1} sourceOut={2} />';
  await writeFile(join(source, "scene.py"), entry);
  await writeFile(join(source, "index.html"), html);
  await writeFile(join(source, "__template_baseline__.html"), html);
  await writeFile(join(project, "index.tsx"), timeline);
  const config = { source: "animations/diagram with spaces", output: "assets/diagram.mp4" };
  await writeFile(join(project, "package.json"), JSON.stringify({ diffusion: { animations: {
    diagram: { engine: "manim", ...config, entry: "scene.py", scene: "Diagram", frameRate: 60 },
    title: { engine: "hyperframes", ...config },
    template: { engine: "hyperframes", ...config, entry: "index.html" },
  } } }));

  const fake = join(project, "fake-renderer");
  await writeFile(fake, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.DIFFUSION_RENDER_TEST_CALL, JSON.stringify({args, cwd: process.cwd(), telemetry: process.env.HYPERFRAMES_NO_TELEMETRY}));
if (process.env.DIFFUSION_RENDER_TEST_FAIL) process.exit(7);
const output = args[args.indexOf(args.includes('--output_file') ? '--output_file' : '--output') + 1];
fs.writeFileSync(output, process.env.DIFFUSION_RENDER_TEST_EMPTY ? '' : 'rendered video');
`, { mode: 0o755 });
  const callPath = join(project, "call.json");
  process.env.DIFFUSION_PYTHON = fake;
  process.env.DIFFUSION_HYPERFRAMES_BIN = fake;
  process.env.DIFFUSION_RENDER_TEST_CALL = callPath;
  await writeFile(join(project, "ffprobe"), `#!${process.execPath}\nconsole.log(JSON.stringify({streams:[{avg_frame_rate:'30/1',width:2,height:2}]}));\n`, { mode: 0o755 });
  process.env.PATH = `${project}:${process.env.PATH}`;

  const [unrendered] = await listAnimations(project, "manim");
  assert.equal((await listAnimations(project)).length, 3);
  assert.equal(unrendered.id, "diagram");
  assert.ok("engine" in unrendered);
  assert.equal(unrendered.renderedAt, null);
  assert.equal(unrendered.libraryPath, "diagram.mp4");
  assert.equal(unrendered.transparent, false);
  await assert.rejects(renderAnimation("title", project, "manim"), /not a manim animation/);

  const first = await renderAnimation("diagram", project);
  const [preview] = await listAnimations(project, "manim");
  assert.ok("engine" in preview && preview.renderedAt);
  assert.equal(await readFile(join(project, "index.tsx"), "utf8"), timeline);
  const manim = JSON.parse(await readFile(callPath, "utf8"));
  assert.deepEqual(manim.args.slice(0, 4), ["-m", "manim", "render", "--renderer"]);
  assert.equal(manim.args[manim.args.indexOf("--fps") + 1], "60");
  assert.deepEqual(manim.args.slice(-2), [join(source, "scene.py"), "Diagram"]);
  assert.equal(manim.cwd, source);
  assert.equal(first.backup, undefined);
  assert.equal(await readFile(first.output, "utf8"), "rendered video");

  await writeFile(first.output, "last good video");
  process.env.DIFFUSION_RENDER_TEST_FAIL = "1";
  await assert.rejects(renderAnimation("title", project), /exited 7/);
  assert.equal(await readFile(first.output, "utf8"), "last good video");
  delete process.env.DIFFUSION_RENDER_TEST_FAIL;
  process.env.DIFFUSION_RENDER_TEST_EMPTY = "1";
  await assert.rejects(renderAnimation("title", project), /non-empty MP4/);
  assert.equal(await readFile(first.output, "utf8"), "last good video");
  delete process.env.DIFFUSION_RENDER_TEST_EMPTY;

  const second = await renderAnimation("title", project);
  const hyperframes = JSON.parse(await readFile(callPath, "utf8"));
  assert.equal(hyperframes.args[0], "render");
  assert.ok(hyperframes.args.includes("--low-memory-mode"));
  assert.ok(!hyperframes.args.includes("--composition"));
  assert.equal(hyperframes.telemetry, "1");
  assert.ok(second.backup);
  assert.equal(await readFile(second.backup, "utf8"), "last good video");
  assert.equal(await readFile(second.output, "utf8"), "rendered video");
  await renderAnimation("template", project);
  const template = JSON.parse(await readFile(callPath, "utf8"));
  assert.deepEqual(template.args.slice(0, 3), ["render", "--composition", "index.html"]);
  assert.equal(await readFile(join(source, "__template_baseline__.html"), "utf8"), html);
  assert.equal(await readFile(join(source, "scene.py"), "utf8"), entry);
  assert.equal(await readFile(join(source, "index.html"), "utf8"), html);
  assert.equal(await readFile(join(project, "index.tsx"), "utf8"), timeline);
  const assets = await readdir(join(project, "assets"));
  assert.deepEqual(assets.filter((name) => !name.startsWith(".")), ["diagram.mp4"]);
  assert.ok(assets.every((name) => !name.startsWith(".animation-")));
});

test("validates registry paths, scene names, and symbolic links before running a renderer", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "diffusion-animation-boundary-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(join(project, "animations"));
  await writeFile(join(project, "animations", "scene.py"), "pass");
  await symlink(tmpdir(), join(project, "linked"));
  const config = { engine: "manim", source: "animations", entry: "scene.py", scene: "Diagram", output: "assets/diagram.mp4" };
  const cases = [
    { change: { engine: "shell" }, error: /engine must be/ },
    { change: { source: "../outside" }, error: /inside the project/ },
    { change: { output: join(tmpdir(), "escape.mp4") }, error: /relative path/ },
    { change: { output: "../escape.mp4" }, error: /inside the project/ },
    { change: { output: "linked/escape.mp4" }, error: /symbolic links/ },
    { change: { output: "animations/source.mp4" }, error: /outside its source/ },
    { change: { output: "index.tsx" }, error: /end in .mp4/ },
    { change: { transparent: "yes" }, error: /transparent must be a boolean/ },
    { change: { frameRate: 0 }, error: /frameRate/ },
    { change: { frameRate: 241 }, error: /frameRate/ },
    { change: { frameRate: "60" }, error: /frameRate/ },
    { change: { transparent: true }, error: /end in .frames/ },
    { change: { output: "assets/diagram.frames" }, error: /end in .mp4/ },
    { change: { entry: "../index.py" }, error: /inside the project/ },
    { change: { engine: "hyperframes", entry: "../index.html" }, error: /inside the project/ },
    { change: { engine: "hyperframes", entry: "scene.py" }, error: /must name an HTML file/ },
    { change: { scene: "Diagram; touch marker" }, error: /Python class name/ },
  ];
  for (const { change, error } of cases) {
    await writeFile(join(project, "package.json"), JSON.stringify({ diffusion: { animations: { example: { ...config, ...change } } } }));
    await assert.rejects(renderAnimation("example", project), error);
  }
  await assert.rejects(access(join(project, "assets")), { code: "ENOENT" });
  await assert.rejects(renderAnimation("missing", project), /Unknown animation/);
  const [invalid] = await listAnimations(project, "manim");
  assert.match(invalid.error ?? "", /Python class name/);
  await writeFile(join(project, "package.json"), "{}");
  assert.deepEqual(await listAnimations(project, "manim"), []);
});

test("renders transparent Manim frames, rejects incomplete output, and retains safe backups", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "diffusion-alpha-"));
  const before = { ...process.env };
  t.after(async () => {
    process.env = before;
    await rm(project, { recursive: true, force: true });
  });
  const source = join(project, "animations");
  const output = join(project, "assets", "diagram.frames");
  await mkdir(source);
  await writeFile(join(source, "scene.py"), "from manim import *\nclass Diagram(Scene):\n    pass\n");
  const timeline = '<video src="diagram.frames" start={4} />';
  await writeFile(join(project, "index.tsx"), timeline);
  await writeFile(join(project, "package.json"), JSON.stringify({ diffusion: { animations: {
    diagram: { engine: "manim", source: "animations", entry: "scene.py", scene: "Diagram", transparent: true, output: "assets/diagram.frames" },
  } } }));
  const fake = join(project, "fake-renderer");
  const callPath = join(project, "call.json");
  await writeFile(fake, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.DIFFUSION_RENDER_TEST_CALL, JSON.stringify(args));
fs.writeFileSync(args[args.indexOf('--output_file') + 1], 'lossless alpha movie');
`, { mode: 0o755 });
  await writeFile(join(project, "ffprobe"), `#!${process.execPath}\nconsole.log(JSON.stringify({streams:[{avg_frame_rate:'30/1',width:2,height:2}]}));\n`, { mode: 0o755 });
  await writeFile(join(project, "ffmpeg"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('-h')) {
  console.log(process.env.DIFFUSION_RENDER_TEST_FFMPEG_HELP);
  process.exit(0);
}
fs.writeFileSync(process.env.DIFFUSION_RENDER_TEST_CALL + '.ffmpeg', JSON.stringify(args));
const output = args.at(-1);
const frame = (number) => output.replace('%06d', number.toString().padStart(6, '0'));
const mode = process.env.DIFFUSION_RENDER_TEST_MODE;
const png = Buffer.from('${png.toString("base64")}', 'base64');
setTimeout(() => {
  fs.writeFileSync(frame(1), mode === 'invalid' ? 'invalid png' : png);
  if (mode === 'fail') process.exit(7);
  const second = Buffer.from(png);
  if (mode === 'dimensions') second.writeUInt32BE(3, 16);
  if (mode !== 'single') fs.writeFileSync(frame(mode === 'gap' ? 3 : 2), mode === 'empty' ? '' : second);
  if (mode === 'unrelated') fs.writeFileSync(require('node:path').join(require('node:path').dirname(output), 'notes.txt'), 'keep me');
}, Number(process.env.DIFFUSION_RENDER_TEST_DELAY || 0));
`, { mode: 0o755 });
  process.env.DIFFUSION_PYTHON = fake;
  process.env.DIFFUSION_RENDER_TEST_CALL = callPath;
  process.env.PATH = `${project}:${process.env.PATH}`;

  const parameters = spawnSync("ffmpeg", ["-hide_banner", "-h", "filter=setparams"], { env: before, encoding: "utf8" });
  assert.equal(parameters.status, 0, parameters.stderr || parameters.error?.message);
  process.env.DIFFUSION_RENDER_TEST_FFMPEG_HELP = parameters.stdout;
  const [unrendered] = await listAnimations(project, "manim");
  assert.ok("engine" in unrendered);
  assert.equal(unrendered.transparent, true);
  assert.equal(unrendered.libraryPath, "diagram.frames");
  assert.equal(unrendered.renderedAt, null);
  const first = await renderAnimation("diagram", project);
  assert.equal(first.transparent, true);
  const args: string[] = JSON.parse(await readFile(callPath, "utf8"));
  assert.equal(args[args.indexOf("--format") + 1], "mov");
  assert.equal(args[args.indexOf("--fps") + 1], "30");
  assert.ok(args.includes("--transparent"));
  const ffmpeg: string[] = JSON.parse(await readFile(`${callPath}.ffmpeg`, "utf8"));
  assert.equal(ffmpeg[ffmpeg.indexOf("-fps_mode") + 1], "passthrough");
  assert.equal(ffmpeg[ffmpeg.indexOf("-pix_fmt") + 1], "rgba");
  const filter = ffmpeg[ffmpeg.indexOf("-vf") + 1];
  assert.ok(filter);
  const pixels = Buffer.from([126, 49, 42, 128, 255, 255, 255, 255, 0, 0, 0, 0]);
  const decoded = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "3x1", "-i", "pipe:0",
    "-vf", filter, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ], { env: before, input: pixels });
  assert.equal(decoded.status, 0, decoded.stderr?.toString() ?? decoded.error?.message);
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(Math.abs(decoded.stdout[channel] - pixels[channel] * 255 / 128) < 1, "Translucent colors must be unpremultiplied before browser compositing");
  }
  assert.equal(decoded.stdout[3], 128);
  assert.deepEqual(decoded.stdout.subarray(4), pixels.subarray(4));

  for (const metadata of [false, true]) {
    process.env.DIFFUSION_RENDER_TEST_FFMPEG_HELP = metadata ? "alpha_mode <int> select alpha mode" : "field_mode <int> select interlace mode";
    await renderAnimation("diagram", project);
    const args: string[] = JSON.parse(await readFile(`${callPath}.ffmpeg`, "utf8"));
    const selected = args[args.indexOf("-vf") + 1];
    assert.equal(selected.startsWith("setparams=alpha_mode=premultiplied,"), metadata);
    assert.ok(selected.includes("unpremultiply=inplace=1"));
  }
  process.env.DIFFUSION_RENDER_TEST_FFMPEG_HELP = parameters.stdout;
  assert.deepEqual(await readdir(output), [".sequence.json", "frame000001.png", "frame000002.png"]);
  assert.deepEqual(JSON.parse(await readFile(join(output, ".sequence.json"), "utf8")), { frameRate: 30 });
  const [rendered] = await listAnimations(project, "manim");
  assert.ok("engine" in rendered && rendered.renderedAt);

  await writeFile(join(output, "frame000001.png"), "last good frame");
  for (const [mode, error] of [["fail", /exited 7/], ["single", /two or more/], ["empty", /empty PNG/], ["unrelated", /matching numbered PNG/], ["gap", /contiguous/], ["invalid", /invalid PNG/], ["dimensions", /matching, nonzero dimensions/]] as const) {
    process.env.DIFFUSION_RENDER_TEST_MODE = mode;
    await assert.rejects(renderAnimation("diagram", project), error);
    assert.equal(await readFile(join(output, "frame000001.png"), "utf8"), "last good frame");
  }
  delete process.env.DIFFUSION_RENDER_TEST_MODE;
  const second = await renderAnimation("diagram", project);
  assert.ok(second.backup);
  assert.equal(await readFile(join(second.backup, "frame000001.png"), "utf8"), "last good frame");
  assert.deepEqual(await readFile(join(output, "frame000001.png")), png);

  // A damaged owned output remains actionable and is backed up on regeneration.
  await rm(join(output, "frame000002.png"));
  const [damaged] = await listAnimations(project, "manim");
  assert.ok("engine" in damaged);
  assert.equal(damaged.renderedAt, null);
  assert.match(damaged.previewError ?? "", /two or more/);
  const repaired = await renderAnimation("diagram", project);
  assert.ok(repaired.backup);
  assert.deepEqual(await readdir(repaired.backup), [".sequence.json", "frame000001.png"]);

  // A registered path cannot repurpose a folder that also holds unrelated data.
  await writeFile(join(output, "notes.txt"), "keep me");
  await assert.rejects(renderAnimation("diagram", project), /matching numbered PNG/);
  const [invalid] = await listAnimations(project, "manim");
  assert.match(invalid.error ?? "", /matching numbered PNG/);
  assert.equal(await readFile(join(output, "notes.txt"), "utf8"), "keep me");
  await rm(join(output, "notes.txt"));
  await rm(join(output, "frame000002.png"));
  await symlink(join(output, "frame000001.png"), join(output, "frame000002.png"));
  await assert.rejects(renderAnimation("diagram", project), /matching numbered PNG/);
  await rm(join(output, "frame000002.png"));
  await writeFile(join(output, "frame000002.png"), "second frame");

  await rm(callPath);
  process.env.DIFFUSION_RENDER_TEST_DELAY = "300";
  const inProgress = renderAnimation("diagram", project);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await access(callPath).then(() => true, () => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await access(callPath);
  await assert.rejects(renderAnimation("diagram", project), /already rendering/);
  await inProgress;
  assert.equal(await readFile(join(project, "index.tsx"), "utf8"), timeline);
  assert.ok((await readdir(join(project, "assets"))).every((name) => !name.startsWith(".animation-")));
});

test("cancels immediately and during a renderer, cleans staging, and allows retry", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "diffusion-animation-cancel-"));
  const before = { ...process.env };
  t.after(async () => { process.env = before; await rm(project, { recursive: true, force: true }); });
  await mkdir(join(project, "source"));
  await mkdir(join(project, "assets"));
  await writeFile(join(project, "source", "index.html"), "<main></main>");
  await writeFile(join(project, "assets", "title.mp4"), "previous video");
  await writeFile(join(project, "package.json"), JSON.stringify({ diffusion: { animations: { title: { engine: "hyperframes", source: "source", output: "assets/title.mp4" } } } }));
  const callPath = join(project, "started.json");
  const fake = join(project, "renderer");
  await writeFile(fake, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync('${callPath}', JSON.stringify({pid:process.pid}));
setTimeout(() => fs.writeFileSync(args[args.indexOf('--output')+1], 'next video'), process.env.DIFFUSION_RENDER_TEST_DELAY ? 5000 : 0);
`, { mode: 0o755 });
  process.env.DIFFUSION_HYPERFRAMES_BIN = fake;
  await writeFile(join(project, "ffprobe"), `#!${process.execPath}\nconsole.log(JSON.stringify({streams:[{avg_frame_rate:'30/1',width:2,height:2}]}));\n`, { mode: 0o755 });
  process.env.PATH = `${project}:${process.env.PATH}`;

  const immediate = renderAnimation("title", project);
  const immediateResult = assert.rejects(immediate, /cancelled/);
  assert.equal(await cancelAnimation("title", project), true);
  await immediateResult;
  await assert.rejects(access(callPath), { code: "ENOENT" });

  process.env.DIFFUSION_RENDER_TEST_DELAY = "1";
  const running = renderAnimation("title", project);
  const cancelled = assert.rejects(running, /cancelled/);
  for (let attempt = 0; attempt < 100 && !await access(callPath).then(() => true, () => false); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const { pid } = JSON.parse(await readFile(callPath, "utf8"));
  assert.equal(await cancelAnimation("title", project), true);
  await cancelled;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(await readFile(join(project, "assets", "title.mp4"), "utf8"), "previous video");
  assert.deepEqual(await readdir(join(project, "assets")), ["title.mp4"]);
  assert.equal(await cancelAnimation("title", project), false);

  const controller = new AbortController();
  controller.abort(new Error("Caller cancelled"));
  await assert.rejects(renderAnimation("title", project, undefined, controller.signal), /Caller cancelled/);
  delete process.env.DIFFUSION_RENDER_TEST_DELAY;
  const retried = await renderAnimation("title", project);
  assert.equal(await readFile(retried.output, "utf8"), "next video");
});
