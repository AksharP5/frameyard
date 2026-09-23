import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparePlaybackCopy } from "../../desktop/src/media-playback.ts";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "studio-playback-"));
  const bin = join(dir, "bin");
  await mkdir(bin);
  const source = join(dir, "source with spaces.mov");
  await writeFile(source, "original");
  await writeFile(join(bin, "ffprobe"), `#!/usr/bin/env node
const fs=require('node:fs');const text=fs.readFileSync(process.argv.at(-1),'utf8');
console.log(JSON.stringify({streams:[{index:0,codec_type:'video',pix_fmt:text==='alpha'?'yuva444p':'yuv422p',color_transfer:text==='hdr'?'smpte2084':'bt709',duration:'2'}],format:{duration:'2'}}));
`, { mode: 0o755 });
  await writeFile(join(bin, "ffmpeg"), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2),source=args[args.indexOf('-i')+1];
const text=fs.readFileSync(source,'utf8');fs.appendFileSync(path.join(path.dirname(source),'calls'),JSON.stringify(args)+'\\n');
fs.writeFileSync(args.at(-1),'compatible '+text);process.stdout.write('out_time_us=1000000\\n');
if(text==='fail'){process.stderr.write('broken input');process.exit(1)}
if(text==='change')fs.appendFileSync(source,'changed');
`, { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  t.after(async () => { process.env.PATH = before; await rm(dir, { recursive: true, force: true }); });
  return { dir, source, input: { dir, source }, calls: async () => (await readFile(join(dir, "calls"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]) };
}

test("playback preparation shares work, preserves the source and reuses a completed copy", async (t) => {
  const f = await fixture(t);
  const progress: number[] = [];
  const [one, two] = await Promise.all([preparePlaybackCopy(f.input, (p) => progress.push(p)), preparePlaybackCopy(f.input)]);
  assert.equal(one, two);
  assert.equal(await readFile(f.source, "utf8"), "original");
  assert.equal(await readFile(one, "utf8"), "compatible original");
  assert.deepEqual(progress, [0, 0.5, 1]);
  assert.equal(await preparePlaybackCopy(f.input), one);
  const calls = await f.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][calls[0].indexOf('-i') + 1], f.source);
  assert.equal(calls[0][calls[0].indexOf('-fps_mode') + 1], 'passthrough');
  assert.deepEqual(await readdir(join(f.dir, ".cache", "playback")), [one.split('/').at(-1)]);
  await writeFile(f.source, "new source contents");
  const refreshed = await preparePlaybackCopy(f.input);
  assert.notEqual(refreshed, one);
  assert.equal((await f.calls()).length, 2);
  assert.equal(await readFile(one, 'utf8'), 'compatible original');
});

test("failed or changing sources never publish a partial playback copy and can be retried", async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, "fail");
  await assert.rejects(preparePlaybackCopy(f.input), /broken input/);
  assert.deepEqual(await readdir(join(f.dir, ".cache", "playback")), []);
  await writeFile(f.source, "change");
  await assert.rejects(preparePlaybackCopy(f.input), /source changed/);
  assert.deepEqual(await readdir(join(f.dir, ".cache", "playback")), []);
  await writeFile(f.source, "fixed");
  assert.ok((await stat(await preparePlaybackCopy(f.input))).size > 0);
});

test("playback preparation rejects source traversal and preserves unsupported alpha and HDR", async (t) => {
  const f = await fixture(t);
  await assert.rejects(preparePlaybackCopy({ dir: f.dir, source: '../outside.mov' }), /leaves the project/);
  for (const [text, message] of [['alpha', /transparency/], ['hdr', /HDR/]] as const) {
    await writeFile(f.source, text);
    await assert.rejects(preparePlaybackCopy(f.input), message);
    assert.equal(await readFile(f.source, "utf8"), text);
  }
  await assert.rejects(readFile(join(f.dir, 'calls')), { code: 'ENOENT' });
});
