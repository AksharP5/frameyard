import assert from "node:assert/strict";
import { test } from "node:test";
import { EncodedAudioPacketSource, EncodedPacket, Output, WebMOutputFormat, type StreamTargetChunk } from "mediabunny";
import { TargetBuffer } from "../../../packages/encoder/src/buffer.ts";

async function fixture() {
  const previous = new TextEncoder().encode("Existing output must survive cancellation");
  let saved = previous;
  let staged = new Uint8Array();
  let closes = 0;
  let aborts = 0;
  const buffer = await TargetBuffer.create({
    async createWritable() {
      return new WritableStream<StreamTargetChunk>({
        write({ data, position }) {
          const next = new Uint8Array(Math.max(staged.length, position + data.length));
          next.set(staged);
          next.set(data, position);
          staged = next;
        },
        close() { saved = staged; closes++; },
        abort() { staged = new Uint8Array(); aborts++; },
      });
    },
  });
  const output = new Output({ format: new WebMOutputFormat(), target: buffer.target });
  const source = new EncodedAudioPacketSource("opus");
  output.addAudioTrack(source);
  await output.start();
  return {
    buffer, output, previous,
    saved: () => saved, closes: () => closes, aborts: () => aborts,
    write: () => source.add(new EncodedPacket(new Uint8Array([0xf8, 0xff, 0xfe]), "key", 0, 0.02), {
      decoderConfig: { codec: "opus", sampleRate: 48_000, numberOfChannels: 2 },
    }),
  };
}

test("Mediabunny cancellation cannot commit an empty or partial file", async () => {
  for (const withPacket of [false, true]) {
    const f = await fixture();
    if (withPacket) await f.write();
    await f.output.cancel();
    assert.deepEqual(f.saved(), f.previous);
    assert.equal(f.closes(), 0);
    await f.buffer.abort();
    assert.equal(f.aborts(), 1);
    assert.deepEqual(f.saved(), f.previous);
  }
});

test("finalized output commits only after the encoder explicitly accepts it", async () => {
  const f = await fixture();
  await f.write();
  await f.output.finalize();
  assert.deepEqual(f.saved(), f.previous);
  assert.equal(f.closes(), 0);
  await f.buffer.close("webm");
  assert.equal(f.closes(), 1);
  assert.notDeepEqual(f.saved(), f.previous);
  assert.ok(f.saved().length > 50);
  await f.buffer.abort();
  assert.equal(f.aborts(), 0, "cleanup cannot abort an already committed export");
});

test("cancellation during finalization can discard finalized staged bytes", async () => {
  const f = await fixture();
  await f.write();
  await f.output.finalize();
  await f.buffer.abort();
  assert.deepEqual(f.saved(), f.previous);
  assert.equal(f.closes(), 0);
  assert.equal(f.aborts(), 1);
});
