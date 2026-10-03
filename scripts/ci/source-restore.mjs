import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const [executable, projectDirectory, outputDirectory] = process.argv.slice(2);
if (!executable || !projectDirectory || !outputDirectory) throw new Error('Usage: node source-restore.mjs <dapi> <smoke-project> <output-directory>');
const project = resolve(projectDirectory), output = resolve(outputDirectory);
const source = join(project, 'index.tsx');
const exec = promisify(execFile);
const cli = async (args, timeout = 10000) => JSON.parse((await exec(executable, ['--project', project, ...args], { timeout, maxBuffer: 2 * 1024 * 1024 })).stdout);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const originalColor = [245, 186, 66], changedColor = [34, 115, 227];
assert.equal(JSON.parse(await readFile(join(project, 'package.json'), 'utf8')).name, 'linux-install-smoke');
const original = await readFile(source);
const originalSha256 = digest(original);
assert.ok(original.toString().includes('id="square"'));
assert.ok(original.toString().includes('fill="#f5ba42"'));
await mkdir(output, { recursive: true });
await writeFile(join(output, 'original-index.tsx'), original);
const evidence = { project, originalSha256, attempts: {}, passed: false };
let changedSha256;

async function screenshot(phase, deadline) {
  const directory = join(output, phase);
  await mkdir(directory, { recursive: true });
  const saved = await cli(['screenshot', '-o', directory], Math.max(1, Math.min(10000, deadline - Date.now())));
  assert.ok(Number.isSafeInteger(saved.width) && saved.width > 0);
  assert.ok(Number.isSafeInteger(saved.height) && saved.height > 0);
  const remaining = deadline - Date.now();
  assert.ok(remaining > 0, `Timed out capturing the live ${phase} canvas`);
  const { stdout: pixels } = await exec('ffmpeg', [
    '-v', 'error', '-threads', '1', '-filter_threads', '1', '-i', saved.path, '-frames:v', '1',
    '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { encoding: 'buffer', timeout: remaining, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(pixels.length, saved.width * saved.height * 3);
  let originalPixels = 0, changedPixels = 0;
  for (let offset = 0; offset < pixels.length; offset += 3) {
    if (pixels[offset] === originalColor[0] && pixels[offset + 1] === originalColor[1] && pixels[offset + 2] === originalColor[2]) originalPixels++;
    if (pixels[offset] === changedColor[0] && pixels[offset + 1] === changedColor[1] && pixels[offset + 2] === changedColor[2]) changedPixels++;
  }
  return { ...saved, originalPixels, changedPixels };
}

async function waitForCanvas(phase, matches) {
  const deadline = Date.now() + 30000;
  const attempts = evidence.attempts[phase] = [];
  while (Date.now() < deadline) {
    const result = await screenshot(phase, deadline);
    attempts.push(result);
    if (matches(result)) return result;
    await delay(Math.min(500, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`The live ${phase} canvas did not show the expected square within 30 seconds: ${JSON.stringify(attempts.at(-1))}`);
}

async function restoreSource() {
  const current = digest(await readFile(source));
  if (current === originalSha256) return;
  assert.ok(changedSha256 && current === changedSha256, 'Source changed outside this regression; refusing to overwrite it. The original source is preserved in the evidence directory.');
  const temporary = join(output, `.restore-${randomUUID()}.tmp`);
  await writeFile(temporary, original, { flag: 'wx' });
  await rename(temporary, source);
  assert.equal(digest(await readFile(source)), originalSha256);
}

try {
  const shown = await cli(['workspace', 'show', project]);
  assert.ok(shown.workspaces.some(workspace => workspace.dir === project && workspace.visible), 'The smoke project is not visible');
  assert.equal((await cli(['context'])).projectDir, project);
  evidence.baseline = await waitForCanvas('baseline', result => result.originalPixels >= 100 && result.changedPixels < 100);
  const update = await cli(['tool', 'editor_update', '--args', JSON.stringify({ id: 'index.tsx:square', props: { fill: '#2273e3' } })]);
  const changed = await readFile(source);
  changedSha256 = digest(changed);
  evidence.changedSha256 = changedSha256;
  assert.equal(update.success, true);
  assert.notEqual(changedSha256, originalSha256, 'The editor did not persist the fill edit');
  assert.ok(changed.toString().includes('#2273e3'));
  evidence.changed = await waitForCanvas('changed', result =>
    result.changedPixels >= evidence.baseline.changedPixels + 100 &&
    result.originalPixels <= evidence.baseline.originalPixels - 100);
  await restoreSource();
  evidence.restoredSha256 = digest(await readFile(source));
  assert.equal(evidence.restoredSha256, originalSha256);
  evidence.restored = await waitForCanvas('restored', result =>
    result.originalPixels >= Math.max(100, evidence.baseline.originalPixels * 0.95) &&
    result.changedPixels <= evidence.baseline.changedPixels + 50);
  assert.equal(digest(await readFile(source)), originalSha256, 'The restored source changed during recompilation');
  evidence.passed = true;
} catch (error) {
  evidence.error = error.message;
  throw error;
} finally {
  try {
    await restoreSource();
  } catch (error) {
    evidence.restoreError = error.message;
    throw error;
  } finally {
    await writeFile(join(output, 'source-restore.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
}
console.log('The visible canvas reflected the fill edit and exact external source restoration.');
