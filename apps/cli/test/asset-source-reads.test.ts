import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const built = await build({
  stdin: { contents: `export {detectMimeType, probeMedia} from './probe'; export {Input} from 'mediabunny';`, resolveDir: fileURLToPath(new URL('../../../packages/assets/src/', import.meta.url)) },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const api = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`) as
  Pick<typeof import('../../../packages/assets/src/probe.ts'), 'detectMimeType' | 'probeMedia'> & Pick<typeof import('mediabunny'), 'Input'>;

test('asset import reads finite ranges of a large source and releases metadata readers on success and failure', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-asset-source-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'source.mp4');
  await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=size=16x16:rate=1', '-t', '2', '-c:v', 'libx264', '-movflags', '+faststart', path]);
  const content = await readFile(path);
  let bytesRead = 0;
  class Recording extends File {
    override get size() { return 40 * 2 ** 30; }
    override slice(start = 0, end?: number): Blob {
      assert.ok(end !== undefined && Number.isFinite(end), 'asset reads must have a finite end');
      const length = Math.min(end, this.size) - start;
      assert.ok(length <= 8 * 2 ** 20, `read requested ${length} bytes`);
      bytesRead += length;
      assert.ok(bytesRead < 16 * 2 ** 20, 'metadata reads must not scan the full recording');
      const bytes = Buffer.alloc(length);
      if (start < content.length) content.copy(bytes, 0, start, Math.min(end, content.length));
      return new Blob([bytes]);
    }
  }
  let disposed = 0;
  const dispose = api.Input.prototype.dispose;
  t.mock.method(api.Input.prototype, 'dispose', function (this: InstanceType<typeof api.Input>) { disposed++; dispose.call(this); });
  const recording = new Recording([], 'recording.mp4');
  const mime = await api.detectMimeType(recording);
  assert.match(mime ?? '', /^video\/mp4/);
  const metadata = await api.probeMedia(recording, mime!);
  assert.ok(metadata.type === 'VIDEO');
  assert.deepEqual([metadata.width, metadata.height, metadata.duration, metadata.frameRate], [16, 16, 2, 1]);
  assert.ok(bytesRead > 0);
  assert.equal(disposed, 2, 'both successful metadata operations release their input');
  const invalid = new Blob(['not media']);
  assert.equal(await api.detectMimeType(invalid), null);
  await assert.rejects(api.probeMedia(invalid, 'video/mp4'));
  assert.equal(disposed, 4, 'failed metadata operations also release their input');
});
