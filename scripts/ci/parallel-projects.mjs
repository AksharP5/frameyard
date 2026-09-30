import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const [executable, directory] = process.argv.slice(2);
if (!executable || !directory) throw new Error('Usage: node parallel-projects.mjs <dapi> <output-directory>');
const root = resolve(directory);
const exec = promisify(execFile);
const cli = async (...args) => JSON.parse((await exec(executable, args, { maxBuffer: 8 * 1024 * 1024 })).stdout);
const colors = [[216, 34, 34], [34, 85, 220], [36, 196, 84]];
await mkdir(root, { recursive: true });
for (const [index, color] of colors.entries()) {
  const project = join(root, String(index));
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: `parallel-${index}`, private: true, main: 'index.tsx' }));
  const fill = '#' + color.map(value => value.toString(16).padStart(2, '0')).join('');
  await writeFile(join(project, 'index.tsx'), `export default function Video() {
    return <stage><scene id="video" width={640} height={360} active><group end={1}>
      <rect width={640} height={360} fill="${fill}" />
      <rect id="square" x={80} y={80} width={200} height={200} fill="#ffffff" />
    </group></scene></stage>;
  }`);
}
const results = await Promise.allSettled(colors.map(async (color, index) => {
  const project = join(root, String(index));
  const call = (...args) => cli('--project', project, ...args);
  assert.equal((await call('context')).projectDir, project);
  assert.equal((await call('tool', 'editor_update', '--args', JSON.stringify({ id: 'square', props: { x: 120 + index * 40 } }))).success, true);
  assert.deepEqual((await call('check', 'video')).issues, []);
  assert.equal((await call('capture', 'video', '-t', '0', '-o', join(project, 'captures'))).images.length, 1);
  const output = join(root, `${index}.mp4`);
  await call('export', 'video', output);
  assert.ok((await readFile(join(project, 'index.tsx'), 'utf8')).includes(`x={${120 + index * 40}}`));
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', output, '-frames:v', '1', '-vf', 'scale=640:360', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 });
  color.forEach((value, channel) => assert.ok(Math.abs(stdout[(20 * 640 + 20) * 3 + channel] - value) <= 8, `Project ${index} exported another project's pixels`));
}));
for (const result of results) if (result.status === 'rejected') throw result.reason;
console.log('Three parallel projects edited, captured and exported with independent source edits and verified MP4 pixels.');
