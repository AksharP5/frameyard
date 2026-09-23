import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { AudioAsset } from '../../../packages/assets/src/types.ts';

const built = await build({
  stdin: { contents: `export {getAudioTrack} from './audio'; export {EncodedPacketSink} from 'mediabunny';`, resolveDir: fileURLToPath(new URL('../../../packages/runtime/src/media/', import.meta.url)) },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const api = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`) as
  Pick<typeof import('../../../packages/runtime/src/media/audio.ts'), 'getAudioTrack'> & Pick<typeof import('mediabunny'), 'EncodedPacketSink'>;

/** A 40 GiB file containing PCM WAVE audio and sparse trailing bytes; only requested ranges are materialized. */
class Recording extends File {
  reads: number[] = [];
  override get size() { return 40 * 2 ** 30; }
  override slice(start = 0, end?: number): Blob {
    assert.ok(end !== undefined && Number.isFinite(end), 'every read must have a finite end, never a stream to EOF');
    const length = Math.min(end, this.size) - start;
    assert.ok(length <= 8 * 2 ** 20, `read requested ${length} bytes`);
    this.reads.push(length);
    assert.ok(this.reads.reduce((sum, bytes) => sum + bytes, 0) < 16 * 2 ** 20, 'total read budget exceeded');
    const buffer = Buffer.alloc(length);
    if (start < 44) {
      const header = Buffer.alloc(44);
      header.write('RIFF'); header.writeUInt32LE(48000 * 4 * 1200 + 36, 4); header.write('WAVEfmt ', 8);
      header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
      header.writeUInt32LE(48000, 24); header.writeUInt32LE(192000, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
      header.write('data', 36); header.writeUInt32LE(48000 * 4 * 1200, 40);
      header.copy(buffer, 0, start, Math.min(44, end));
    }
    return new Blob([buffer]);
  }
}

function asset(file: File): AudioAsset {
  return { id: 'recording', path: file.name, source: `assets/${file.name}`, createdAt: '', mimeType: 'audio/wav', type: 'AUDIO', duration: 1000, channels: 2, sampleRate: 48000, handle: { getFile: async () => file } };
}

test('large original audio uses bounded slices for metadata and distant packet reads', async () => {
  const file = new Recording([], 'long.wav');
  const track = await api.getAudioTrack(asset(file));
  assert.ok(track);
  assert.equal(await track.getSampleRate(), 48000);
  const sink = new api.EncodedPacketSink(track);
  for (const seconds of [0, 1100]) assert.ok(await sink.getPacket(seconds));
  assert.ok(file.reads.length > 0);
  assert.ok(file.reads.reduce((sum, bytes) => sum + bytes, 0) < 16 * 2 ** 20, 'metadata and two packets never read the full recording');
});

test('native PCM fallback also uses bounded file slices', async () => {
  const file = new Recording([], 'fallback.wav');
  const invalid = asset(new File(['unreadable source'], 'source.mov'));
  const track = await api.getAudioTrack(invalid, 0, {
    audioFile: async () => file,
    openVideo: async () => { throw new Error('audio reads must not request video decoding'); },
  });
  assert.ok(track);
  assert.equal(await track.getNumberOfChannels(), 2);
  assert.ok(file.reads.length > 0);
});
