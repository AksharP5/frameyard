import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import type { VideoAsset } from '../../../packages/assets/src/types.ts';

const built = await build({
  stdin: { contents: `export {getVideoTrack, VideoExporter} from './video'; export {EncodedPacketSink} from 'mediabunny';`, resolveDir: fileURLToPath(new URL('../../../packages/runtime/src/media/', import.meta.url)) },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const api = await import(`data:text/javascript;base64,${Buffer.from(`${built.outputFiles[0].text}\n//# sourceURL=video-source-reads-bundle.js`).toString('base64')}`) as
  Pick<typeof import('../../../packages/runtime/src/media/video.ts'), 'getVideoTrack' | 'VideoExporter'> & Pick<typeof import('mediabunny'), 'EncodedPacketSink'>;

test('thumbnail and export video reads remain bounded on a 40 GiB source', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-thumbnail-source-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'source.mp4');
  await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=size=16x16:rate=1', '-t', '2', '-c:v', 'libx264', '-movflags', '+faststart', path]);
  const content = await readFile(path);
  const reads: { start: number; end: number | undefined }[] = [];
  class Recording extends File {
    override get size() { return 40 * 2 ** 30; }
    override slice(start = 0, end?: number): Blob {
      reads.push({ start, end });
      assert.ok(end !== undefined && Number.isFinite(end), 'video reads must have a finite end');
      const length = Math.min(end, this.size) - start;
      assert.ok(length <= 8 * 2 ** 20, `read requested ${length} bytes`);
      const bytes = Buffer.alloc(length);
      if (start < content.length) content.copy(bytes, 0, start, Math.min(end, content.length));
      return new Blob([bytes]);
    }
  }
  const source: VideoAsset = {
    id: 'large-video', path: 'recording.mp4', source: 'assets/recording.mp4', createdAt: '', mimeType: 'video/mp4', type: 'VIDEO',
    duration: 2, width: 16, height: 16, frameRate: 1, bitRate: 0, handle: { getFile: async () => new Recording([], 'recording.mp4') },
  };
  const track = await api.getVideoTrack(source);
  assert.ok(track, 'metadata should remain readable without streaming to EOF');
  const sink = new api.EncodedPacketSink(track);
  assert.ok(await sink.getPacket(0));
  assert.ok(await sink.getPacket(1));
  assert.ok(reads.length > 0);
  assert.ok(reads.every(({ end }) => end !== undefined && Number.isFinite(end)));
  assert.ok(reads.reduce((sum, { start, end }) => sum + end! - start, 0) < 16 * 2 ** 20);

  reads.length = 0;
  let closed = 0;
  const exporter = new api.VideoExporter(source, {
    audioFile: async () => { throw new Error('video export must not read audio'); },
    openVideo: async () => ({ frameRate: 1, read: async () => ({ data: new Uint8Array(4), width: 1, height: 1 }), close: async () => { closed++; } }),
  });
  try {
    await exporter.initialized;
    assert.ok(reads.length > 0);
    assert.ok(reads.every(({ end }) => end !== undefined && Number.isFinite(end)));
    assert.ok(reads.reduce((sum, { start, end }) => sum + end! - start, 0) < 16 * 2 ** 20);
  } finally { exporter.dispose(); }
  assert.equal(closed, 1, 'the original-quality decoder is closed after export');
});
